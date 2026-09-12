import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { D1Database } from '@cloudflare/workers-types';
import { createMeeting, findMeetingByCode, getMeetingForUser, listMeetings, rotateMeetingCode, updateMeeting } from '../meetings';

type MeetingRow = {
	id: string;
	user_id: string;
	title: string | null;
	code: string | null;
	require_approval: number;
	created_at: string;
};

/** An in-memory stand-in for D1 that enforces the same partial-unique(code) constraint the real migration does. */
function mockDb(seed: MeetingRow[] = []) {
	const rows = seed.map((row) => ({ ...row }));
	// Lets a test force the *first* insert/update to collide, deterministically exercising the
	// retry loop instead of hoping a real random code collides with a seeded one by chance.
	let forcedFailures = 0;

	function assertCodeFree(code: string, exceptId?: string) {
		if (forcedFailures > 0) {
			forcedFailures -= 1;
			throw new Error('UNIQUE constraint failed: meetings.code');
		}
		if (rows.some((row) => row.code === code && row.id !== exceptId)) {
			throw new Error('UNIQUE constraint failed: meetings.code');
		}
	}

	const db = {
		prepare(sql: string) {
			return {
				bind(...args: unknown[]) {
					return {
						async first() {
							if (sql.includes('COUNT(*)')) {
								const userId = String(args[0]);
								return { count: rows.filter((row) => row.user_id === userId).length };
							}
							if (sql.includes('WHERE code = ?')) {
								const code = String(args[0]);
								return rows.find((row) => row.code === code) ?? null;
							}
							if (sql.includes('WHERE id = ? AND user_id = ?')) {
								const [id, userId] = args as [string, string];
								return rows.find((row) => row.id === id && row.user_id === userId) ?? null;
							}
							return null;
						},
						async all() {
							if (sql.includes('WHERE user_id = ?')) {
								const userId = String(args[0]);
								return { results: rows.filter((row) => row.user_id === userId) };
							}
							return { results: [] };
						},
						async run() {
							if (sql.startsWith('INSERT INTO meetings')) {
								const [id, userId, , title, code, requireApproval, createdAt] = args as [
									string,
									string,
									string | null,
									string | null,
									string,
									number,
									string
								];
								assertCodeFree(code);
								rows.push({ id, user_id: userId, title, code, require_approval: requireApproval, created_at: createdAt });
								return { meta: { changes: 1 } };
							}
							if (sql.startsWith('UPDATE meetings SET code')) {
								const [code, id, userId] = args as [string, string, string];
								const row = rows.find((entry) => entry.id === id && entry.user_id === userId);
								if (!row) return { meta: { changes: 0 } };
								assertCodeFree(code, id);
								row.code = code;
								return { meta: { changes: 1 } };
							}
							if (sql.startsWith('UPDATE meetings SET')) {
								// updateMeeting: last two bound args are always [id, userId]
								const id = String(args[args.length - 2]);
								const userId = String(args[args.length - 1]);
								const row = rows.find((entry) => entry.id === id && entry.user_id === userId);
								if (!row) return { meta: { changes: 0 } };
								let cursor = 0;
								if (sql.includes('title = ?')) row.title = args[cursor++] as string | null;
								if (sql.includes('require_approval = ?')) row.require_approval = args[cursor++] as number;
								return { meta: { changes: 1 } };
							}
							return { meta: { changes: 0 } };
						}
					};
				}
			};
		}
	} as unknown as D1Database;

	return { db, rows, forceNextCollision: () => (forcedFailures += 1) };
}

describe('default titles', () => {
	test('the first meeting is "Meeting #1", the next is "#2"', async () => {
		const { db } = mockDb();
		const first = await createMeeting(db, 'user-1');
		const second = await createMeeting(db, 'user-1');
		assert.equal(first.meeting.title, 'Meeting #1');
		assert.equal(second.meeting.title, 'Meeting #2');
	});

	test('a given title is used as-is instead of a default', async () => {
		const { db } = mockDb();
		const created = await createMeeting(db, 'user-1', { title: 'Standup' });
		assert.equal(created.meeting.title, 'Standup');
	});

	test("default numbering is per user, not global", async () => {
		const { db } = mockDb();
		await createMeeting(db, 'user-1');
		const other = await createMeeting(db, 'user-2');
		assert.equal(other.meeting.title, 'Meeting #1');
	});
});

describe('creating and joining a meeting', () => {
	test('the code looks up the meeting, a wrong one does not', async () => {
		const { db } = mockDb();
		const created = await createMeeting(db, 'user-1', { title: 'Standup' });

		assert.equal((await findMeetingByCode(db, created.code))?.id, created.meeting.id);
		assert.equal(await findMeetingByCode(db, 'not-the-code'), null);
	});

	test('meetings default to open (no approval required)', async () => {
		const { db } = mockDb();
		const created = await createMeeting(db, 'user-1');
		assert.equal(created.meeting.require_approval, false);
	});

	test('requireApproval can be set at creation', async () => {
		const { db } = mockDb();
		const created = await createMeeting(db, 'user-1', { requireApproval: true });
		assert.equal(created.meeting.require_approval, true);
	});

	test('the same code works again on a second visit — it is looked up, not consumed', async () => {
		const { db } = mockDb();
		const created = await createMeeting(db, 'user-1');

		assert.equal((await findMeetingByCode(db, created.code))?.id, created.meeting.id);
		assert.equal((await findMeetingByCode(db, created.code))?.id, created.meeting.id);
	});

	test('the generated code matches the xxx-xxxx-xxx shape', async () => {
		const { db } = mockDb();
		const created = await createMeeting(db, 'user-1');
		assert.match(created.code, /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/);
	});

	test('a code collision is retried rather than failing the create', async () => {
		const { db, rows, forceNextCollision } = mockDb();
		forceNextCollision();

		const created = await createMeeting(db, 'user-1');
		assert.match(created.code, /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/);
		assert.equal(rows.length, 1);
	});
});

describe('listing meetings', () => {
	test("only returns the requesting user's own rows", async () => {
		const { db } = mockDb([
			{ id: 'a', user_id: 'user-1', title: 'Mine', code: 'aaa-aaaa-aaa', require_approval: 0, created_at: '2026-01-01T00:00:00.000Z' },
			{ id: 'b', user_id: 'user-2', title: 'Theirs', code: 'bbb-bbbb-bbb', require_approval: 0, created_at: '2026-01-01T00:00:00.000Z' }
		]);

		const meetings = await listMeetings(db, 'user-1');
		assert.deepEqual(
			meetings.map((meeting) => meeting.id),
			['a']
		);
	});
});

describe('updateMeeting', () => {
	test('updates only the fields given, ownership-checked', async () => {
		const { db } = mockDb();
		const created = await createMeeting(db, 'user-1', { title: 'Old title' });

		const updated = await updateMeeting(db, 'user-1', created.meeting.id, { requireApproval: true });
		assert.equal(updated?.title, 'Old title');
		assert.equal(updated?.require_approval, true);

		const renamed = await updateMeeting(db, 'user-1', created.meeting.id, { title: 'New title' });
		assert.equal(renamed?.title, 'New title');
		assert.equal(renamed?.require_approval, true);
	});

	test('cannot update a meeting owned by someone else', async () => {
		const { db } = mockDb();
		const created = await createMeeting(db, 'user-1');

		const result = await updateMeeting(db, 'user-2', created.meeting.id, { title: 'Hijacked' });
		assert.equal(result, null);
		assert.equal((await getMeetingForUser(db, 'user-1', created.meeting.id))?.title, created.meeting.title);
	});
});

describe('rotating a meeting code', () => {
	test('the old code stops working and the new one works', async () => {
		const { db } = mockDb();
		const created = await createMeeting(db, 'user-1');

		const rotated = await rotateMeetingCode(db, 'user-1', created.meeting.id);
		assert.ok(rotated);

		assert.equal(await findMeetingByCode(db, created.code), null);
		assert.equal((await findMeetingByCode(db, rotated as string))?.id, created.meeting.id);
	});

	test('cannot rotate a meeting owned by someone else', async () => {
		const { db, rows } = mockDb([
			{ id: 'a', user_id: 'user-1', title: null, code: 'aaa-aaaa-aaa', require_approval: 0, created_at: '2026-01-01T00:00:00.000Z' }
		]);

		const rotated = await rotateMeetingCode(db, 'user-2', 'a');
		assert.equal(rotated, null);
		assert.equal(rows[0].code, 'aaa-aaaa-aaa');
	});

	test('a collision on rotate is retried rather than failing', async () => {
		const { db, forceNextCollision } = mockDb();
		const created = await createMeeting(db, 'user-1');

		forceNextCollision();
		const rotated = await rotateMeetingCode(db, 'user-1', created.meeting.id);
		assert.ok(rotated);
		assert.notEqual(rotated, created.code);
	});
});
