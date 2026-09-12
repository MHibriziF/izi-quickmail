import type { D1Database } from '@cloudflare/workers-types';
import { hashToken } from './util/crypto';
import { generateTotpSecret, otpauthUri, verifyTotp } from './util/totp';

export const BACKUP_CODE_COUNT = 10;
/** Crockford-ish: no I, L, O, U, so a written-down code cannot be misread. */
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_LENGTH = 8;

export type TwoFactorStatus = {
	enabled: boolean;
	enabledAt: string | null;
	/** Recovery codes still unused. Zero means the next lost phone is a lockout. */
	backupCodesRemaining: number;
};

type TotpRow = { totp_secret: string | null; totp_enabled: number };

async function readTotp(db: D1Database, userId: string): Promise<TotpRow | null> {
	return db
		.prepare('SELECT totp_secret, totp_enabled FROM users WHERE id = ?')
		.bind(userId)
		.first<TotpRow>();
}

export async function getTwoFactorStatus(
	db: D1Database,
	userId: string
): Promise<TwoFactorStatus> {
	const row = await db
		.prepare('SELECT totp_enabled, totp_enabled_at FROM users WHERE id = ?')
		.bind(userId)
		.first<{ totp_enabled: number; totp_enabled_at: string | null }>();

	const remaining = await db
		.prepare('SELECT COUNT(*) AS count FROM totp_backup_codes WHERE user_id = ? AND used_at IS NULL')
		.bind(userId)
		.first<{ count: number }>();

	return {
		enabled: row?.totp_enabled === 1,
		enabledAt: row?.totp_enabled_at ?? null,
		backupCodesRemaining: remaining?.count ?? 0
	};
}

/** True once the user has finished enrolling — the only state login should gate on. */
export async function isTwoFactorEnabled(db: D1Database, userId: string): Promise<boolean> {
	const row = await readTotp(db, userId);
	return row?.totp_enabled === 1 && Boolean(row.totp_secret);
}

/**
 * Mints a fresh secret and parks it unconfirmed.
 *
 * Re-enrolling overwrites any half-finished attempt, which is what makes the
 * "scanned the wrong thing, start over" path work. An enabled account is left
 * alone — turning 2FA off is an explicit, password-checked action.
 */
export async function startEnrollment(
	db: D1Database,
	userId: string,
	accountEmail: string,
	issuer: string
): Promise<{ secret: string; uri: string }> {
	if (await isTwoFactorEnabled(db, userId)) {
		throw new Error('Two-factor authentication is already on');
	}

	const secret = generateTotpSecret();
	await db
		.prepare('UPDATE users SET totp_secret = ?, totp_enabled = 0 WHERE id = ?')
		.bind(secret, userId)
		.run();

	return { secret, uri: otpauthUri(secret, accountEmail, issuer) };
}

function newBackupCode(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(CODE_LENGTH));
	let code = '';
	for (const byte of bytes) {
		code += CODE_ALPHABET[byte % CODE_ALPHABET.length];
	}
	return `${code.slice(0, 4)}-${code.slice(4)}`;
}

export function normalizeBackupCode(code: string): string {
	return code.replace(/[\s-]/g, '').toUpperCase();
}

/** Replaces any existing codes. Returned in the clear exactly once. */
export async function issueBackupCodes(db: D1Database, userId: string): Promise<string[]> {
	const codes = Array.from({ length: BACKUP_CODE_COUNT }, newBackupCode);

	const inserts = await Promise.all(
		codes.map(async (code) =>
			db
				.prepare('INSERT INTO totp_backup_codes (id, user_id, code_hash) VALUES (?, ?, ?)')
				.bind(crypto.randomUUID(), userId, await hashToken(normalizeBackupCode(code)))
		)
	);

	await db.batch([
		db.prepare('DELETE FROM totp_backup_codes WHERE user_id = ?').bind(userId),
		...inserts
	]);

	return codes;
}

/**
 * Confirms enrolment with a code from the app, which proves the secret was
 * actually stored somewhere before it starts gating logins.
 */
export async function confirmEnrollment(
	db: D1Database,
	userId: string,
	code: string
): Promise<string[]> {
	const row = await readTotp(db, userId);
	if (!row?.totp_secret) {
		throw new Error('Start setup again — there is nothing to confirm');
	}
	if (row.totp_enabled === 1) {
		throw new Error('Two-factor authentication is already on');
	}
	if (!(await verifyTotp(row.totp_secret, code))) {
		throw new Error('That code did not match. Check your authenticator and try again.');
	}

	await db
		.prepare(
			"UPDATE users SET totp_enabled = 1, totp_enabled_at = datetime('now') WHERE id = ?"
		)
		.bind(userId)
		.run();

	return issueBackupCodes(db, userId);
}

export async function disableTwoFactor(db: D1Database, userId: string): Promise<void> {
	await db.batch([
		db
			.prepare(
				'UPDATE users SET totp_secret = NULL, totp_enabled = 0, totp_enabled_at = NULL WHERE id = ?'
			)
			.bind(userId),
		db.prepare('DELETE FROM totp_backup_codes WHERE user_id = ?').bind(userId)
	]);
}

/**
 * Checks a login challenge against the authenticator, then the recovery codes.
 *
 * A backup code is burned on use, so a code read off a screenshot or a shoulder
 * cannot be replayed.
 */
export async function verifyChallenge(
	db: D1Database,
	userId: string,
	code: string
): Promise<boolean> {
	const row = await readTotp(db, userId);
	if (!row?.totp_secret || row.totp_enabled !== 1) return false;

	if (await verifyTotp(row.totp_secret, code)) return true;

	const hash = await hashToken(normalizeBackupCode(code));
	const match = await db
		.prepare(
			'SELECT id FROM totp_backup_codes WHERE user_id = ? AND code_hash = ? AND used_at IS NULL'
		)
		.bind(userId, hash)
		.first<{ id: string }>();

	if (!match) return false;

	// Conditioned on still being unused, so two racing logins cannot both spend
	// the same code.
	const spent = await db
		.prepare("UPDATE totp_backup_codes SET used_at = datetime('now') WHERE id = ? AND used_at IS NULL")
		.bind(match.id)
		.run();

	return (spent.meta.changes ?? 0) === 1;
}
