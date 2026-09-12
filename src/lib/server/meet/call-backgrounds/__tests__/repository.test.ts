import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { R2Bucket } from '@cloudflare/workers-types';
import { createFakeD1 } from '../../../__tests__/support/fake-d1';
import { createD1CallBackgroundsRepository } from '../repository';

type Row = {
	id: string;
	user_id: string;
	storage_key: string;
	content_type: string;
	size_bytes: number;
	created_at: string;
};

function setup() {
	const rows: Row[] = [];
	let clock = 0;

	const db = createFakeD1(({ sql, args }) => {
		if (sql.startsWith('INSERT INTO call_backgrounds')) {
			const [id, userId, storageKey, contentType, sizeBytes] = args as [string, string, string, string, number];
			clock += 1;
			rows.push({ id, user_id: userId, storage_key: storageKey, content_type: contentType, size_bytes: sizeBytes, created_at: `t${clock}` });
			return [];
		}
		if (sql.startsWith('DELETE FROM call_backgrounds')) {
			const [id] = args as [string];
			const index = rows.findIndex((row) => row.id === id);
			if (index !== -1) rows.splice(index, 1);
			return [];
		}
		if (sql.includes('WHERE id = ? AND user_id = ?')) {
			const [id, userId] = args as [string, string];
			return rows.filter((row) => row.id === id && row.user_id === userId);
		}
		if (sql.includes('WHERE id = ?')) {
			const [id] = args as [string];
			return rows.filter((row) => row.id === id);
		}
		if (sql.includes('ORDER BY created_at ASC')) {
			const [userId] = args as [string];
			return rows
				.filter((row) => row.user_id === userId)
				.sort((a, b) => a.created_at.localeCompare(b.created_at))
				.map((row) => ({ id: row.id, storage_key: row.storage_key }));
		}
		if (sql.includes('ORDER BY created_at DESC')) {
			const [userId] = args as [string];
			return rows
				.filter((row) => row.user_id === userId)
				.sort((a, b) => b.created_at.localeCompare(a.created_at));
		}
		throw new Error(`Unhandled query in fake D1: ${sql}`);
	});

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

	return { repo: createD1CallBackgroundsRepository(db, () => bucket), db, rows, stored };
}

describe('CallBackgroundsRepository', () => {
	test('insert stores the row and the blob, and getForUser reads back the row', async () => {
		const { repo, stored } = setup();
		const saved = await repo.insert({
			id: 'bg-1',
			userId: 'user-1',
			storageKey: 'call-backgrounds/user-1/bg-1/beach.png',
			contentType: 'image/png',
			sizeBytes: 3,
			bytes: new Uint8Array([1, 2, 3]),
			filename: 'beach.png'
		});

		assert.equal(saved.content_type, 'image/png');
		assert.equal(stored.size, 1);
		assert.equal((await repo.getForUser('user-1', 'bg-1'))?.storage_key, 'call-backgrounds/user-1/bg-1/beach.png');
		assert.equal(await repo.getForUser('someone-else', 'bg-1'), null);
	});

	test('listForUser is newest first and owner-scoped', async () => {
		const { repo } = setup();
		await repo.insert({ id: 'a', userId: 'user-1', storageKey: 'k/a', contentType: 'image/png', sizeBytes: 1, bytes: new Uint8Array([1]), filename: 'a.png' });
		await repo.insert({ id: 'b', userId: 'user-1', storageKey: 'k/b', contentType: 'image/png', sizeBytes: 1, bytes: new Uint8Array([1]), filename: 'b.png' });
		await repo.insert({ id: 'c', userId: 'user-2', storageKey: 'k/c', contentType: 'image/png', sizeBytes: 1, bytes: new Uint8Array([1]), filename: 'c.png' });

		assert.deepEqual((await repo.listForUser('user-1')).map((row) => row.id), ['b', 'a']);
	});

	test('listOldestFirstForUser is oldest first, with the storage key', async () => {
		const { repo } = setup();
		await repo.insert({ id: 'a', userId: 'user-1', storageKey: 'k/a', contentType: 'image/png', sizeBytes: 1, bytes: new Uint8Array([1]), filename: 'a.png' });
		await repo.insert({ id: 'b', userId: 'user-1', storageKey: 'k/b', contentType: 'image/png', sizeBytes: 1, bytes: new Uint8Array([1]), filename: 'b.png' });

		assert.deepEqual(await repo.listOldestFirstForUser('user-1'), [
			{ id: 'a', storage_key: 'k/a' },
			{ id: 'b', storage_key: 'k/b' }
		]);
	});

	test('remove deletes both the row and the blob', async () => {
		const { repo, rows, stored } = setup();
		await repo.insert({ id: 'a', userId: 'user-1', storageKey: 'k/a', contentType: 'image/png', sizeBytes: 1, bytes: new Uint8Array([1]), filename: 'a.png' });
		assert.equal(stored.size, 1);

		await repo.remove('a', 'k/a');
		assert.equal(rows.length, 0);
		assert.equal(stored.size, 0);
	});

	test('readBytes returns null for a missing key', async () => {
		const { repo } = setup();
		assert.equal(await repo.readBytes('no-such-key'), null);
	});

	test('listing rows never touches the bucket, so a missing R2 binding does not break it', async () => {
		const { db } = setup();
		const readOnlyRepo = createD1CallBackgroundsRepository(db, () => {
			throw new Error('bucket should not be requested for a read');
		});

		await assert.doesNotReject(readOnlyRepo.listForUser('user-1'));
		await assert.doesNotReject(readOnlyRepo.getForUser('user-1', 'missing'));
	});
});
