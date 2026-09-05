import type { D1Database, R2Bucket } from '@cloudflare/workers-types';
import { SESSION_COOKIE, SESSION_DAYS } from './constants';
import { createSessionToken, hashPassword, hashToken, verifyPassword } from './crypto';
import { MAX_USER_NAME_LENGTH, MIN_PASSWORD_LENGTH } from '$lib/constants';
import { isTwoFactorEnabled, verifyChallenge } from './two-factor';
import type { User } from '$lib/types';

type UserRow = {
	id: string;
	email: string;
	name: string;
	is_admin: number;
	created_at: string;
};

function mapUser(row: UserRow): User {
	return {
		id: row.id,
		email: row.email,
		name: row.name,
		is_admin: row.is_admin === 1,
		created_at: row.created_at
	};
}

export async function countUsers(db: D1Database): Promise<number> {
	const row = await db.prepare('SELECT COUNT(*) AS count FROM users').first<{ count: number }>();
	return row?.count ?? 0;
}

export async function getUserByEmail(db: D1Database, email: string): Promise<(User & { password_hash: string }) | null> {
	const row = await db
		.prepare('SELECT id, email, name, password_hash, is_admin, created_at FROM users WHERE email = ?')
		.bind(email.toLowerCase())
		.first<UserRow & { password_hash: string }>();

	return row ? { ...mapUser(row), password_hash: row.password_hash } : null;
}

export async function getUserById(db: D1Database, id: string): Promise<User | null> {
	const row = await db
		.prepare('SELECT id, email, name, is_admin, created_at FROM users WHERE id = ?')
		.bind(id)
		.first<UserRow>();

	return row ? mapUser(row) : null;
}

export async function listUsers(db: D1Database): Promise<User[]> {
	const { results } = await db
		.prepare('SELECT id, email, name, is_admin, created_at FROM users ORDER BY created_at ASC')
		.all<UserRow>();

	return results.map(mapUser);
}

export async function createUser(
	db: D1Database,
	input: { email: string; name: string; password: string; isAdmin?: boolean }
): Promise<User> {
	// This is a login identity only. Mail identities live in `addresses` and are
	// bound to connected Resend domains, so an operator can sign in with any
	// address they control while sending as name@their-resend-domain.
	const email = input.email.toLowerCase().trim();
	if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
		throw new Error('Enter a valid email address');
	}

	const existing = await getUserByEmail(db, email);
	if (existing) {
		throw new Error('An account with that email already exists');
	}

	const id = crypto.randomUUID();
	const password_hash = await hashPassword(input.password);

	await db
		.prepare(
			'INSERT INTO users (id, email, name, password_hash, is_admin) VALUES (?, ?, ?, ?, ?)'
		)
		.bind(id, email, input.name.trim(), password_hash, input.isAdmin ? 1 : 0)
		.run();

	const user = await getUserById(db, id);
	if (!user) throw new Error('Failed to create user');
	return user;
}

export async function bootstrapAdmin(
	db: D1Database,
	input: { email: string; name: string; password: string }
): Promise<User> {
	const existing = await countUsers(db);
	if (existing > 0) {
		throw new Error('Setup already completed');
	}

	return createUser(db, { ...input, isAdmin: true });
}

/**
 * Issues a session for an already-authenticated user.
 *
 * Separate from `login` so paths that have their own proof of identity — the
 * first-run setup, and re-signing a tab after its own password change — do not
 * get asked for a second factor they have already satisfied.
 */
export async function startSession(
	db: D1Database,
	user: User
): Promise<{ user: User; token: string }> {
	const token = createSessionToken();
	const token_hash = await hashToken(token);
	const sessionId = crypto.randomUUID();
	const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000).toISOString();

	await db
		.prepare('INSERT INTO sessions (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)')
		.bind(sessionId, user.id, token_hash, expiresAt)
		.run();

	return { user, token };
}

export type LoginResult =
	| { ok: true; user: User; token: string }
	| { ok: false; reason: 'invalid' | 'totp_required' | 'totp_invalid' };

/**
 * Password first, then the second factor if the account has one.
 *
 * No session exists until both pass, so a correct password on its own buys an
 * attacker nothing.
 */
export async function login(
	db: D1Database,
	email: string,
	password: string,
	code?: string
): Promise<LoginResult> {
	const user = await getUserByEmail(db, email);
	if (!user) return { ok: false, reason: 'invalid' };

	const valid = await verifyPassword(password, user.password_hash);
	if (!valid) return { ok: false, reason: 'invalid' };

	const { password_hash: _, ...safeUser } = user;

	if (await isTwoFactorEnabled(db, safeUser.id)) {
		if (!code?.trim()) return { ok: false, reason: 'totp_required' };
		if (!(await verifyChallenge(db, safeUser.id, code))) {
			return { ok: false, reason: 'totp_invalid' };
		}
	}

	return { ok: true, ...(await startSession(db, safeUser)) };
}

export async function logout(db: D1Database, token: string): Promise<void> {
	const token_hash = await hashToken(token);
	await db.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(token_hash).run();
}

export async function setUserPassword(
	db: D1Database,
	userId: string,
	password: string
): Promise<void> {
	if (password.length < MIN_PASSWORD_LENGTH) {
		throw new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
	}

	const password_hash = await hashPassword(password);
	const result = await db
		.prepare('UPDATE users SET password_hash = ? WHERE id = ?')
		.bind(password_hash, userId)
		.run();

	if ((result.meta.changes ?? 0) === 0) {
		throw new Error('User not found');
	}

	// Password rotation must cut off every login path, including long-lived keys.
	await db.batch([
		db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(userId),
		db.prepare('DELETE FROM api_tokens WHERE user_id = ?').bind(userId)
	]);
}

/** Rename a login identity. Mail identities carry their own display names. */
export async function setUserName(db: D1Database, userId: string, name: string): Promise<User> {
	const trimmed = name.trim();
	if (!trimmed) {
		throw new Error('Name cannot be empty');
	}
	if (trimmed.length > MAX_USER_NAME_LENGTH) {
		throw new Error(`Name must be ${MAX_USER_NAME_LENGTH} characters or fewer`);
	}

	const result = await db
		.prepare('UPDATE users SET name = ? WHERE id = ?')
		.bind(trimmed, userId)
		.run();

	if ((result.meta.changes ?? 0) === 0) {
		throw new Error('User not found');
	}

	const user = await getUserById(db, userId);
	if (!user) throw new Error('User not found');
	return user;
}

/**
 * Grant or withdraw admin.
 *
 * Promotion needs no guard. Demotion does: the count travels with the UPDATE
 * rather than being read first, so two admins demoting each other concurrently
 * cannot both pass a stale check and leave the instance with nobody. Demoting
 * someone who is already not an admin is a no-op that still reports success.
 */
export async function setUserAdmin(
	db: D1Database,
	actor: User,
	targetId: string,
	isAdmin: boolean
): Promise<void> {
	if (actor.id === targetId) {
		throw new Error('You cannot change your own role');
	}

	const target = await getUserById(db, targetId);
	if (!target) {
		throw new Error('User not found');
	}

	if (isAdmin) {
		await db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').bind(targetId).run();
		return;
	}

	const result = await db
		.prepare(
			`UPDATE users SET is_admin = 0
			 WHERE id = ?
			   AND (is_admin = 0 OR (SELECT COUNT(*) FROM users WHERE is_admin = 1) > 1)`
		)
		.bind(targetId)
		.run();

	if ((result.meta?.changes ?? 0) === 0) {
		throw new Error('Keep at least one admin');
	}
}

/**
 * Removes the account and everything the D1 cascade takes with it — sessions,
 * addresses, mail — plus the R2 objects the mail's attachments point at, which
 * the cascade cannot reach.
 */
export async function deleteUser(
	db: D1Database,
	bucket: R2Bucket | undefined,
	actor: User,
	targetId: string
): Promise<void> {
	if (actor.id === targetId) {
		throw new Error('You cannot delete your own account');
	}

	const target = await getUserById(db, targetId);
	if (!target) {
		throw new Error('User not found');
	}

	// One transaction: D1 rolls a batch back entirely if any statement fails, so
	// the account can never be gone while its mail, sessions and tokens survive.
	//
	// The key read is the batch's first statement rather than a preceding query.
	// Reading outside the transaction leaves a window in which inbound delivery
	// commits an attachment whose metadata this then deletes without ever having
	// collected its object.
	//
	// The last-admin rule rides on the DELETE rather than a preceding read —
	// counting first and deleting after lets two admins delete each other
	// concurrently, both seeing two admins, leaving nobody. The child statements
	// are then gated on the user actually having gone, so a refused delete
	// leaves the account whole instead of stripping it inside the same batch.
	//
	// Older D1 databases were created without ON DELETE CASCADE enforcement, so
	// the children are cleared explicitly; where the cascade ran they are no-ops.
	// email_attachments is reachable only through emails, so it goes first.
	const gone = 'NOT EXISTS (SELECT 1 FROM users WHERE id = ?)';
	const [keys, deletion] = await db.batch<{ storage_key: string }>([
		db
			.prepare(
				`SELECT storage_key FROM email_attachments
				 WHERE storage_key IS NOT NULL
				   AND email_id IN (SELECT id FROM emails WHERE user_id = ?)`
			)
			.bind(targetId),
		db
			.prepare(
				`DELETE FROM users
				 WHERE id = ?
				   AND (is_admin = 0 OR (SELECT COUNT(*) FROM users WHERE is_admin = 1) > 1)`
			)
			.bind(targetId),
		db
			.prepare(
				`DELETE FROM email_attachments
				 WHERE email_id IN (SELECT id FROM emails WHERE user_id = ?) AND ${gone}`
			)
			.bind(targetId, targetId),
		db.prepare(`DELETE FROM emails WHERE user_id = ? AND ${gone}`).bind(targetId, targetId),
		db.prepare(`DELETE FROM addresses WHERE user_id = ? AND ${gone}`).bind(targetId, targetId),
		db.prepare(`DELETE FROM sessions WHERE user_id = ? AND ${gone}`).bind(targetId, targetId),
		db.prepare(`DELETE FROM api_tokens WHERE user_id = ? AND ${gone}`).bind(targetId, targetId),
		db
			.prepare(`DELETE FROM push_subscriptions WHERE user_id = ? AND ${gone}`)
			.bind(targetId, targetId),
		db
			.prepare(
				`UPDATE domains SET catchall_user_id = NULL WHERE catchall_user_id = ? AND ${gone}`
			)
			.bind(targetId, targetId)
	]);

	if ((deletion.meta?.changes ?? 0) === 0) {
		throw new Error('Keep at least one admin');
	}

	const storageKeys = (keys.results ?? []).map((row) => row.storage_key);

	// Purged only after the row is gone, so a refused delete never strands mail
	// without the files it references. Best-effort from here: the account is
	// already deleted, so a storage hiccup must not report failure — the caller
	// would retry and be told the user does not exist, with the strays no longer
	// reachable from any metadata. Log them instead.
	if (bucket && storageKeys.length > 0) {
		const purged = await Promise.allSettled(storageKeys.map((key) => bucket.delete(key)));
		purged.forEach((outcome, index) => {
			if (outcome.status === 'rejected') {
				console.error('Failed to delete attachment object', storageKeys[index], outcome.reason);
			}
		});
	}
}

export async function getUserFromSession(db: D1Database, token: string | undefined): Promise<User | null> {
	if (!token) return null;

	const token_hash = await hashToken(token);
	const row = await db
		.prepare(
			`SELECT u.id, u.email, u.name, u.is_admin, u.created_at
			 FROM sessions s
			 JOIN users u ON u.id = s.user_id
			 WHERE s.token_hash = ? AND s.expires_at > datetime('now')`
		)
		.bind(token_hash)
		.first<UserRow>();

	return row ? mapUser(row) : null;
}

export function sessionCookieOptions(maxAgeSeconds: number) {
	return {
		path: '/',
		httpOnly: true,
		secure: true,
		sameSite: 'lax' as const,
		maxAge: maxAgeSeconds
	};
}

export function readSessionToken(cookies: { get: (name: string) => string | undefined }): string | undefined {
	return cookies.get(SESSION_COOKIE);
}

export { SESSION_COOKIE };
