import type { D1Database } from '@cloudflare/workers-types';

export type Meeting = {
	id: string;
	code: string | null;
	title: string | null;
	created_at: string;
};

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

/**
 * The code is the whole join credential (like a Google Meet/Zoom meeting
 * code) — no separate hidden token. It's stored and shown in the clear so a
 * host can always see and reshare it, not just once at creation time.
 */
export async function createMeeting(
	db: D1Database,
	userId: string,
	options: { title?: string; domainId?: string | null } = {}
): Promise<CreatedMeeting> {
	const id = crypto.randomUUID();
	const title = options.title?.trim().slice(0, 200) || null;
	const createdAt = new Date().toISOString();

	for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS; attempt++) {
		const code = createMeetingCode();
		try {
			await db
				.prepare(
					`INSERT INTO meetings (id, user_id, domain_id, title, code, created_at)
					 VALUES (?, ?, ?, ?, ?, ?)`
				)
				.bind(id, userId, options.domainId ?? null, title, code, createdAt)
				.run();

			return { code, meeting: { id, code, title, created_at: createdAt } };
		} catch (error) {
			if (!isUniqueConstraintError(error) || attempt === MAX_CODE_ATTEMPTS - 1) throw error;
		}
	}

	throw new Error('Could not generate a unique meeting code');
}

export async function listMeetings(db: D1Database, userId: string): Promise<Meeting[]> {
	const { results } = await db
		.prepare('SELECT id, code, title, created_at FROM meetings WHERE user_id = ? ORDER BY created_at DESC')
		.bind(userId)
		.all<Meeting>();

	return results;
}

/** Looked up, not verified against a guess — the code itself is the whole credential now. */
export async function findMeetingByCode(db: D1Database, code: string): Promise<Meeting | null> {
	const row = await db
		.prepare('SELECT id, code, title, created_at FROM meetings WHERE code = ?')
		.bind(code)
		.first<Meeting>();

	return row ?? null;
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
