import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { D1Database, R2Bucket } from '@cloudflare/workers-types';
import {
	deleteCallBackground,
	getCallBackgroundForUser,
	insertCallBackground,
	listCallBackgrounds
} from './call-backgrounds';

type Row = {
	id: string;
	user_id: string;
	storage_key: string;
	content_type: string;
	size_bytes: number;
	created_at: string;
};

/** An in-memory stand-in for D1 that understands only the handful of queries call-backgrounds.ts issues. */
function mockDb() {
	const rows: Row[] = [];
	let clock = 0;

	const db = {
		prepare(sql: string) {
			return {
				bind(...args: unknown[]) {
					return {
						async run() {
							if (sql.startsWith('INSERT INTO call_backgrounds')) {
								const [id, user_id, storage_key, content_type, size_bytes] = args as [
									string,
									string,
									string,
									string,
									number
								];
								clock += 1;
								rows.push({
									id,
									user_id,
									storage_key,
									content_type,
									size_bytes,
									created_at: `t${clock}`
								});
							} else if (sql.startsWith('DELETE FROM call_backgrounds')) {
								const [id] = args as [string];
								const index = rows.findIndex((row) => row.id === id);
								if (index !== -1) rows.splice(index, 1);
							}
							return { meta: { changes: 1 } };
						},
						async first() {
							if (sql.includes('WHERE id = ? AND user_id = ?')) {
								const [id, userId] = args as [string, string];
								return rows.find((row) => row.id === id && row.user_id === userId) ?? null;
							}
							if (sql.includes('WHERE id = ?')) {
								const [id] = args as [string];
								return rows.find((row) => row.id === id) ?? null;
							}
							return null;
						},
						async all() {
							const [userId] = args as [string];
							const results = rows
								.filter((row) => row.user_id === userId)
								.sort((a, b) => (sql.includes('DESC') ? b.created_at.localeCompare(a.created_at) : a.created_at.localeCompare(b.created_at)));
							return { results };
						}
					};
				}
			};
		}
	} as unknown as D1Database;

	return { db, rows };
}

function mockBucket() {
	const stored = new Map<string, Uint8Array>();
	const bucket = {
		async put(key: string, bytes: Uint8Array) {
			stored.set(key, bytes);
		},
		async get(key: string) {
			const bytes = stored.get(key);
			if (!bytes) return null;
			return { async arrayBuffer() { return bytes.buffer; } };
		},
		async delete(key: string) {
			stored.delete(key);
		}
	} as unknown as R2Bucket;
	return { bucket, stored };
}

describe('call backgrounds', () => {
	test('rejects a non-image upload', async () => {
		const { db } = mockDb();
		const { bucket } = mockBucket();
		await assert.rejects(
			() => insertCallBackground(db, bucket, 'user-1', { filename: 'a.txt', type: 'text/plain', bytes: new Uint8Array(1) }),
			/image/
		);
	});

	test('rejects an oversized upload', async () => {
		const { db } = mockDb();
		const { bucket } = mockBucket();
		await assert.rejects(
			() =>
				insertCallBackground(db, bucket, 'user-1', {
					filename: 'a.png',
					type: 'image/png',
					bytes: new Uint8Array(6 * 1024 * 1024)
				}),
			/exceeds/
		);
	});

	test('stores an upload and lists it back for its owner only', async () => {
		const { db } = mockDb();
		const { bucket } = mockBucket();

		const saved = await insertCallBackground(db, bucket, 'user-1', {
			filename: 'beach.png',
			type: 'image/png',
			bytes: new Uint8Array([1, 2, 3])
		});

		assert.equal(saved.content_type, 'image/png');
		assert.deepEqual((await listCallBackgrounds(db, 'user-1')).map((row) => row.id), [saved.id]);
		assert.deepEqual(await listCallBackgrounds(db, 'user-2'), []);
		assert.equal(await getCallBackgroundForUser(db, 'user-2', saved.id), null);
	});

	test('drops the oldest upload once the gallery is at capacity', async () => {
		const { db, rows } = mockDb();
		const { bucket, stored } = mockBucket();

		let oldestId = '';
		for (let index = 0; index < 6; index += 1) {
			const saved = await insertCallBackground(db, bucket, 'user-1', {
				filename: `bg-${index}.png`,
				type: 'image/png',
				bytes: new Uint8Array([index])
			});
			if (index === 0) oldestId = saved.id;
		}
		assert.equal(rows.length, 6);

		await insertCallBackground(db, bucket, 'user-1', {
			filename: 'bg-6.png',
			type: 'image/png',
			bytes: new Uint8Array([6])
		});

		assert.equal(rows.length, 6);
		assert.ok(!rows.some((row) => row.id === oldestId), 'oldest row should have been dropped');
		assert.ok(![...stored.keys()].some((key) => key.includes(oldestId)), 'oldest bytes should have been deleted');
	});

	test('deleteCallBackground removes the row and bytes, and is scoped to the owner', async () => {
		const { db } = mockDb();
		const { bucket, stored } = mockBucket();

		const saved = await insertCallBackground(db, bucket, 'user-1', {
			filename: 'beach.png',
			type: 'image/png',
			bytes: new Uint8Array([1])
		});
		assert.equal(stored.size, 1);

		assert.equal(await deleteCallBackground(db, bucket, 'user-2', saved.id), false);
		assert.equal(stored.size, 1);

		assert.equal(await deleteCallBackground(db, bucket, 'user-1', saved.id), true);
		assert.equal(stored.size, 0);
		assert.deepEqual(await listCallBackgrounds(db, 'user-1'), []);
	});
});
