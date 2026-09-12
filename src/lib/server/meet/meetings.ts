import type { D1Database } from '@cloudflare/workers-types';

export type Meeting = {
	id: string;
	user_id: string;
	code: string | null;
	title: string | null;
	require_approval: boolean;
	created_at: string;
};

type MeetingRow = Omit<Meeting, 'require_approval'> & { require_approval: number };

function toMeeting(row: MeetingRow): Meeting {
	return { ...row, require_approval: !!row.require_approval };
}

/** A freshly created meeting: the join code plus its summary. */
export type CreatedMeeting = {
	code: string;
	meeting: Meeting;
};

const CODE_GROUP_LENGTHS = [3, 4, 3];
const CODE_ALPHABET = 'abcdefghijklmnopqrstuvwxyz';
const MAX_CODE_ATTEMPTS = 5;

/**
 * A short, typeable join code in Google Meet's shape (`xxx-xxxx-xxx`). This is
 * the entire join credential now — see the module doc below — so it's plain
 * text, not something derived from a secret.
 */
export function createMeetingCode(): string {
	return CODE_GROUP_LENGTHS.map(randomLetters).join('-');
}

function randomLetters(length: number): string {
	const bytes = crypto.getRandomValues(new Uint8Array(length));
	let result = '';
	for (const byte of bytes) result += CODE_ALPHABET[byte % CODE_ALPHABET.length];
	return result;
}

/** `Meeting #N` for the caller's Nth meeting, used whenever no title is given at creation. */
async function nextDefaultTitle(db: D1Database, userId: string): Promise<string> {
	const row = await db
		.prepare('SELECT COUNT(*) AS count FROM meetings WHERE user_id = ?')
		.bind(userId)
		.first<{ count: number }>();

	return `Meeting #${(row?.count ?? 0) + 1}`;
}

/**
 * The code is the whole join credential (like a Google Meet/Zoom meeting
 * code) — no separate hidden token. It's stored and shown in the clear so a
 * host can always see and reshare it, not just once at creation time.
 */
export async function createMeeting(
	db: D1Database,
	userId: string,
	options: { title?: string; domainId?: string | null; requireApproval?: boolean } = {}
): Promise<CreatedMeeting> {
	const id = crypto.randomUUID();
	const title = options.title?.trim().slice(0, 200) || (await nextDefaultTitle(db, userId));
	const requireApproval = options.requireApproval ?? false;
	const createdAt = new Date().toISOString();

	for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS; attempt++) {
		const code = createMeetingCode();
		try {
			await db
				.prepare(
					`INSERT INTO meetings (id, user_id, domain_id, title, code, require_approval, created_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?)`
				)
				.bind(id, userId, options.domainId ?? null, title, code, requireApproval ? 1 : 0, createdAt)
				.run();

			return {
				code,
				meeting: { id, user_id: userId, code, title, require_approval: requireApproval, created_at: createdAt }
			};
		} catch (error) {
			if (!isUniqueConstraintError(error) || attempt === MAX_CODE_ATTEMPTS - 1) throw error;
		}
	}

	throw new Error('Could not generate a unique meeting code');
}

export async function listMeetings(db: D1Database, userId: string): Promise<Meeting[]> {
	const { results } = await db
		.prepare(
			'SELECT id, user_id, code, title, require_approval, created_at FROM meetings WHERE user_id = ? ORDER BY created_at DESC'
		)
		.bind(userId)
		.all<MeetingRow>();

	return results.map(toMeeting);
}

/** Looked up, not verified against a guess — the code itself is the whole credential now. */
export async function findMeetingByCode(db: D1Database, code: string): Promise<Meeting | null> {
	const row = await db
		.prepare('SELECT id, user_id, code, title, require_approval, created_at FROM meetings WHERE code = ?')
		.bind(code)
		.first<MeetingRow>();

	return row ? toMeeting(row) : null;
}

/** Ownership-checked partial update — backs both the /meetings list edit and the in-call host settings panel. */
export async function updateMeeting(
	db: D1Database,
	userId: string,
	id: string,
	changes: { title?: string; requireApproval?: boolean }
): Promise<Meeting | null> {
	const sets: string[] = [];
	const values: unknown[] = [];

	if (changes.title !== undefined) {
		sets.push('title = ?');
		values.push(changes.title.trim().slice(0, 200) || null);
	}
	if (changes.requireApproval !== undefined) {
		sets.push('require_approval = ?');
		values.push(changes.requireApproval ? 1 : 0);
	}
	if (sets.length === 0) return getMeetingForUser(db, userId, id);

	const result = await db
		.prepare(`UPDATE meetings SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`)
		.bind(...values, id, userId)
		.run();

	if ((result.meta.changes ?? 0) === 0) return null;
	return getMeetingForUser(db, userId, id);
}

export async function getMeetingForUser(db: D1Database, userId: string, id: string): Promise<Meeting | null> {
	const row = await db
		.prepare('SELECT id, user_id, code, title, require_approval, created_at FROM meetings WHERE id = ? AND user_id = ?')
		.bind(id, userId)
		.first<MeetingRow>();

	return row ? toMeeting(row) : null;
}

/**
 * Mints a fresh code for a meeting, e.g. after the old one was shared too
 * widely. The room itself (see livekit.ts, keyed by the stable internal id)
 * is untouched, so this doesn't disrupt anyone already on a call.
 */
export async function rotateMeetingCode(db: D1Database, userId: string, id: string): Promise<string | null> {
	for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS; attempt++) {
		const code = createMeetingCode();
		try {
			const result = await db
				.prepare('UPDATE meetings SET code = ? WHERE id = ? AND user_id = ?')
				.bind(code, id, userId)
				.run();

			return (result.meta.changes ?? 0) > 0 ? code : null;
		} catch (error) {
			if (!isUniqueConstraintError(error) || attempt === MAX_CODE_ATTEMPTS - 1) throw error;
		}
	}

	throw new Error('Could not generate a unique meeting code');
}

function isUniqueConstraintError(error: unknown): boolean {
	return error instanceof Error && /unique constraint/i.test(error.message);
}
