import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { D1Database } from '@cloudflare/workers-types';
import { createAdmission, getAdmission, listPendingAdmissions, setAdmissionStatus } from '../admissions';

type AdmissionRow = {
	id: string;
	meeting_id: string;
	name: string;
	status: string;
	created_at: string;
};

function mockDb(seed: AdmissionRow[] = []) {
	const rows = seed.map((row) => ({ ...row }));
	let clock = 0;

	const db = {
		prepare(sql: string) {
			return {
				bind(...args: unknown[]) {
					return {
						async run() {
							if (sql.startsWith('INSERT INTO meeting_admissions')) {
								const [id, meetingId, name] = args as [string, string, string];
								clock += 1;
								rows.push({ id, meeting_id: meetingId, name, status: 'pending', created_at: `t${clock}` });
								return { meta: { changes: 1 } };
							}
							if (sql.startsWith('UPDATE meeting_admissions SET status')) {
								const [status, id, meetingId] = args as [string, string, string];
								const row = rows.find((entry) => entry.id === id && entry.meeting_id === meetingId);
								if (!row) return { meta: { changes: 0 } };
								row.status = status;
								return { meta: { changes: 1 } };
							}
							return { meta: { changes: 0 } };
						},
						async first() {
							const [id, meetingId] = args as [string, string];
							const row = rows.find((entry) => entry.id === id && entry.meeting_id === meetingId);
							return row ? { status: row.status } : null;
						},
						async all() {
							const meetingId = String(args[0]);
							return {
								results: rows
									.filter((row) => row.meeting_id === meetingId && row.status === 'pending')
									.sort((a, b) => (a.created_at < b.created_at ? -1 : 1))
									.map((row) => ({ id: row.id, name: row.name, created_at: row.created_at }))
							};
						}
					};
				}
			};
		}
	} as unknown as D1Database;

	return { db, rows };
}

describe('admissions', () => {
	test('a new request starts pending and is found by meeting + id', async () => {
		const { db } = mockDb();
		const admission = await createAdmission(db, 'meeting-1', 'Ada');

		assert.equal((await getAdmission(db, 'meeting-1', admission.id))?.status, 'pending');
	});

	test('an admission from a different meeting is not found (scoped)', async () => {
		const { db } = mockDb();
		const admission = await createAdmission(db, 'meeting-1', 'Ada');

		assert.equal(await getAdmission(db, 'meeting-2', admission.id), null);
	});

	test('an empty name falls back to "Guest"', async () => {
		const { db, rows } = mockDb();
		await createAdmission(db, 'meeting-1', '   ');
		assert.equal(rows[0].name, 'Guest');
	});

	test('listPendingAdmissions only returns pending rows for that meeting, oldest first', async () => {
		const { db } = mockDb();
		const first = await createAdmission(db, 'meeting-1', 'Ada');
		const second = await createAdmission(db, 'meeting-1', 'Grace');
		await createAdmission(db, 'meeting-2', 'Someone else');
		await setAdmissionStatus(db, 'meeting-1', first.id, 'admitted');

		const pending = await listPendingAdmissions(db, 'meeting-1');
		assert.deepEqual(
			pending.map((admission) => admission.id),
			[second.id]
		);
	});

	test('setAdmissionStatus is scoped to the meeting and reports whether it found a row', async () => {
		const { db } = mockDb();
		const admission = await createAdmission(db, 'meeting-1', 'Ada');

		assert.equal(await setAdmissionStatus(db, 'meeting-2', admission.id, 'denied'), false);
		assert.equal((await getAdmission(db, 'meeting-1', admission.id))?.status, 'pending');

		assert.equal(await setAdmissionStatus(db, 'meeting-1', admission.id, 'denied'), true);
		assert.equal((await getAdmission(db, 'meeting-1', admission.id))?.status, 'denied');
	});
});
