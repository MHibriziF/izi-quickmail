import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { D1Database } from '@cloudflare/workers-types';
import { hashToken } from './crypto';
import { createMeeting, listMeetings, rotateMeetingToken, verifyMeetingToken } from './meetings';

type MeetingRow = {
	id: string;
	user_id: string;
	title: string | null;
	token_hash: string;
	created_at: string;
};

function mockDb(seed: MeetingRow[] = []) {
	const rows = seed.map((row) => ({ ...row }));

	const db = {
		prepare(sql: string) {
			return {
				bind(...args: unknown[]) {
					return {
						async first() {
							if (sql.startsWith('SELECT token_hash')) {
								const id = String(args[0]);
								const row = rows.find((entry) => entry.id === id);
								return row ? { token_hash: row.token_hash } : null;
							}
							return null;
						},
						async all() {
							if (sql.startsWith('SELECT id, title, created_at')) {
								const userId = String(args[0]);
								return {
									results: rows
										.filter((row) => row.user_id === userId)
										.sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
										.map((row) => ({ id: row.id, title: row.title, created_at: row.created_at }))
								};
							}
							return { results: [] };
						},
						async run() {
							if (sql.startsWith('INSERT INTO meetings')) {
								const [id, userId, , title, tokenHash, createdAt] = args as [
									string,
									string,
									string | null,
									string | null,
									string,
									string
								];
								rows.push({ id, user_id: userId, title, token_hash: tokenHash, created_at: createdAt });
								return { meta: { changes: 1 } };
							}
							if (sql.startsWith('UPDATE meetings SET token_hash')) {
								const [tokenHash, id, userId] = args as [string, string, string];
								const row = rows.find((entry) => entry.id === id && entry.user_id === userId);
								if (!row) return { meta: { changes: 0 } };
								row.token_hash = tokenHash;
								return { meta: { changes: 1 } };
							}
							return { meta: { changes: 0 } };
						}
					};
				}
			};
		}
	} as unknown as D1Database;

	return { db, rows };
}

describe('creating and joining a meeting', () => {
	test('the raw token verifies, a wrong one does not', async () => {
		const { db } = mockDb();
		const created = await createMeeting(db, 'user-1', { title: 'Standup' });

		assert.equal(await verifyMeetingToken(db, created.meeting.id, created.token), true);
		assert.equal(await verifyMeetingToken(db, created.meeting.id, 'not-the-token'), false);
	});

	test('an unknown meeting id never verifies', async () => {
		const { db } = mockDb();
		assert.equal(await verifyMeetingToken(db, 'no-such-id', 'anything'), false);
	});

	test('the same link works again on a second visit — it is checked, not consumed', async () => {
		const { db } = mockDb();
		const created = await createMeeting(db, 'user-1');

		assert.equal(await verifyMeetingToken(db, created.meeting.id, created.token), true);
		assert.equal(await verifyMeetingToken(db, created.meeting.id, created.token), true);
	});
});

describe('listing meetings', () => {
	test('only returns the requesting user\'s own rows', async () => {
		const { db } = mockDb([
			{ id: 'a', user_id: 'user-1', title: 'Mine', token_hash: 'x', created_at: '2026-01-01T00:00:00.000Z' },
			{ id: 'b', user_id: 'user-2', title: 'Theirs', token_hash: 'y', created_at: '2026-01-01T00:00:00.000Z' }
		]);

		const meetings = await listMeetings(db, 'user-1');
		assert.deepEqual(
			meetings.map((meeting) => meeting.id),
			['a']
		);
	});
});

describe('rotating a meeting token', () => {
	test('the old link stops working and the new one works', async () => {
		const { db } = mockDb();
		const created = await createMeeting(db, 'user-1');

		const rotated = await rotateMeetingToken(db, 'user-1', created.meeting.id);
		assert.ok(rotated);

		assert.equal(await verifyMeetingToken(db, created.meeting.id, created.token), false);
		assert.equal(await verifyMeetingToken(db, created.meeting.id, rotated as string), true);
	});

	test('cannot rotate a meeting owned by someone else', async () => {
		const { db, rows } = mockDb([
			{
				id: 'a',
				user_id: 'user-1',
				title: null,
				token_hash: await hashToken('secret'),
				created_at: '2026-01-01T00:00:00.000Z'
			}
		]);

		const rotated = await rotateMeetingToken(db, 'user-2', 'a');
		assert.equal(rotated, null);
		assert.equal(rows[0].token_hash, await hashToken('secret'));
	});
});
