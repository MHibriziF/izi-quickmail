import type { D1Database } from '@cloudflare/workers-types';
import { createSessionToken, hashToken } from '../crypto';

export type Meeting = {
	id: string;
	title: string | null;
	created_at: string;
};

type MeetingRow = {
	id: string;
	title: string | null;
	token_hash: string;
	created_at: string;
};

/** A freshly created meeting: the raw join token (shown once) plus its summary. */
export type CreatedMeeting = {
	token: string;
	meeting: Meeting;
};

export async function createMeeting(
	db: D1Database,
	userId: string,
	options: { title?: string; domainId?: string | null } = {}
): Promise<CreatedMeeting> {
	const id = crypto.randomUUID();
	const token = createSessionToken();
	const title = options.title?.trim().slice(0, 200) || null;
	const createdAt = new Date().toISOString();

	await db
		.prepare(
			`INSERT INTO meetings (id, user_id, domain_id, title, token_hash, created_at)
			 VALUES (?, ?, ?, ?, ?, ?)`
		)
		.bind(id, userId, options.domainId ?? null, title, await hashToken(token), createdAt)
		.run();

	return { token, meeting: { id, title, created_at: createdAt } };
}

export async function listMeetings(db: D1Database, userId: string): Promise<Meeting[]> {
	const { results } = await db
		.prepare('SELECT id, title, created_at FROM meetings WHERE user_id = ? ORDER BY created_at DESC')
		.bind(userId)
		.all<Meeting>();

	return results;
}

/** Checked, not consumed — the same link is shared with and reused by every invitee. */
export async function verifyMeetingToken(db: D1Database, id: string, token: string): Promise<boolean> {
	const row = await db
		.prepare('SELECT token_hash FROM meetings WHERE id = ?')
		.bind(id)
		.first<Pick<MeetingRow, 'token_hash'>>();

	if (!row) return false;
	return timingSafeEqual(row.token_hash, await hashToken(token));
}

/** Rotates a meeting's join secret, e.g. after the original link was shared too widely. */
export async function rotateMeetingToken(
	db: D1Database,
	userId: string,
	id: string
): Promise<string | null> {
	const token = createSessionToken();
	const result = await db
		.prepare('UPDATE meetings SET token_hash = ? WHERE id = ? AND user_id = ?')
		.bind(await hashToken(token), id, userId)
		.run();

	return (result.meta.changes ?? 0) > 0 ? token : null;
}

function timingSafeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let mismatch = 0;
	for (let i = 0; i < a.length; i++) {
		mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
	}
	return mismatch === 0;
}
