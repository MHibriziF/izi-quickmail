import type { D1Database } from '@cloudflare/workers-types';
import { createSessionToken, hashToken } from './crypto';

export type AccountTokenKind = 'password_reset' | 'recovery_email';

/** Short enough that a link left in an inbox stops working quickly. */
export const PASSWORD_RESET_TTL_MINUTES = 30;
export const RECOVERY_EMAIL_TTL_MINUTES = 60;
/**
 * A fresh reset link is not issued while a recent one is still valid. This is
 * the rate limit: without it, the endpoint is an open relay for mailing someone
 * repeatedly, since anyone can name any address.
 */
export const RESET_RESEND_COOLDOWN_MINUTES = 2;

export type RecoveryStatus = {
	/** Verified and in use. */
	email: string | null;
	/** Saved but still waiting on a click. */
	pending: string | null;
	verifiedAt: string | null;
};

export function isLikelyEmail(value: string): boolean {
	return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

export async function getRecoveryStatus(
	db: D1Database,
	userId: string
): Promise<RecoveryStatus> {
	const row = await db
		.prepare(
			'SELECT recovery_email, recovery_email_pending, recovery_email_verified_at FROM users WHERE id = ?'
		)
		.bind(userId)
		.first<{
			recovery_email: string | null;
			recovery_email_pending: string | null;
			recovery_email_verified_at: string | null;
		}>();

	return {
		email: row?.recovery_email ?? null,
		pending: row?.recovery_email_pending ?? null,
		verifiedAt: row?.recovery_email_verified_at ?? null
	};
}

function expiryFrom(minutes: number): string {
	return new Date(Date.now() + minutes * 60_000).toISOString();
}

/**
 * Mints a link token. Only the hash is stored, so a database read cannot be
 * turned back into a working link.
 */
async function issueToken(
	db: D1Database,
	userId: string,
	kind: AccountTokenKind,
	ttlMinutes: number
): Promise<string> {
	const token = createSessionToken();

	await db.batch([
		// One live token per kind — a new link silently retires the old one.
		db
			.prepare('DELETE FROM account_tokens WHERE user_id = ? AND kind = ?')
			.bind(userId, kind),
		db
			.prepare(
				'INSERT INTO account_tokens (id, user_id, kind, token_hash, expires_at) VALUES (?, ?, ?, ?, ?)'
			)
			.bind(crypto.randomUUID(), userId, kind, await hashToken(token), expiryFrom(ttlMinutes))
	]);

	return token;
}

/** Spends a token if it is live, returning the user it belongs to. */
export async function consumeToken(
	db: D1Database,
	kind: AccountTokenKind,
	token: string
): Promise<string | null> {
	const row = await db
		.prepare(
			`SELECT id, user_id FROM account_tokens
			  WHERE kind = ? AND token_hash = ? AND used_at IS NULL AND expires_at > ?`
		)
		.bind(kind, await hashToken(token), new Date().toISOString())
		.first<{ id: string; user_id: string }>();

	if (!row) return null;

	// Conditioned on still being unused, so two clicks cannot both succeed.
	const spent = await db
		.prepare("UPDATE account_tokens SET used_at = datetime('now') WHERE id = ? AND used_at IS NULL")
		.bind(row.id)
		.run();

	return (spent.meta.changes ?? 0) === 1 ? row.user_id : null;
}

/** True while a recent reset link should still be arriving. */
export async function hasRecentResetToken(db: D1Database, userId: string): Promise<boolean> {
	const cutoff = new Date(Date.now() - RESET_RESEND_COOLDOWN_MINUTES * 60_000).toISOString();
	const row = await db
		.prepare(
			`SELECT id FROM account_tokens
			  WHERE user_id = ? AND kind = 'password_reset' AND used_at IS NULL AND created_at > ?`
		)
		.bind(userId, cutoff)
		.first<{ id: string }>();

	return Boolean(row);
}

export async function createPasswordResetToken(
	db: D1Database,
	userId: string
): Promise<string> {
	return issueToken(db, userId, 'password_reset', PASSWORD_RESET_TTL_MINUTES);
}

/** Stores the address as pending and returns the token to mail to it. */
export async function startRecoveryEmailChange(
	db: D1Database,
	userId: string,
	email: string
): Promise<string> {
	const clean = email.trim().toLowerCase();
	if (!isLikelyEmail(clean)) {
		throw new Error('Enter a valid email address');
	}

	await db
		.prepare('UPDATE users SET recovery_email_pending = ? WHERE id = ?')
		.bind(clean, userId)
		.run();

	return issueToken(db, userId, 'recovery_email', RECOVERY_EMAIL_TTL_MINUTES);
}

/** Promotes the pending address once its link is clicked. */
export async function confirmRecoveryEmail(
	db: D1Database,
	userId: string
): Promise<string | null> {
	const row = await db
		.prepare('SELECT recovery_email_pending FROM users WHERE id = ?')
		.bind(userId)
		.first<{ recovery_email_pending: string | null }>();

	const pending = row?.recovery_email_pending;
	if (!pending) return null;

	await db
		.prepare(
			`UPDATE users
			    SET recovery_email = ?, recovery_email_pending = NULL,
			        recovery_email_verified_at = datetime('now')
			  WHERE id = ?`
		)
		.bind(pending, userId)
		.run();

	return pending;
}

export async function clearRecoveryEmail(db: D1Database, userId: string): Promise<void> {
	await db.batch([
		db
			.prepare(
				`UPDATE users
				    SET recovery_email = NULL, recovery_email_pending = NULL,
				        recovery_email_verified_at = NULL
				  WHERE id = ?`
			)
			.bind(userId),
		db
			.prepare("DELETE FROM account_tokens WHERE user_id = ? AND kind = 'recovery_email'")
			.bind(userId)
	]);
}

/** Only a verified address is ever mailed a reset link. */
export async function findResetTarget(
	db: D1Database,
	email: string
): Promise<{ userId: string; recoveryEmail: string } | null> {
	const row = await db
		.prepare(
			`SELECT id, recovery_email FROM users
			  WHERE email = ? COLLATE NOCASE AND recovery_email IS NOT NULL
			    AND recovery_email_verified_at IS NOT NULL`
		)
		.bind(email.trim().toLowerCase())
		.first<{ id: string; recovery_email: string }>();

	return row ? { userId: row.id, recoveryEmail: row.recovery_email } : null;
}
