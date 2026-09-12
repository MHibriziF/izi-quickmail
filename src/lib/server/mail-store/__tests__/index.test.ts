import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { D1Database } from '@cloudflare/workers-types';
import { createFakeD1 } from '../../__tests__/support/fake-d1';
import {
	deleteEmailsPermanently,
	emailExistsByProviderId,
	getMailStoreService,
	insertEmail,
	listMailbox,
	updateEmailStatusByProviderId
} from '../index';

function fakeDb(handlers: Partial<Record<string, unknown[]>> = {}): D1Database {
	return createFakeD1(({ sql }) => {
		for (const [needle, result] of Object.entries(handlers)) {
			if (sql.includes(needle)) return result ?? [];
		}
		return [];
	});
}

describe('getMailStoreService', () => {
	test('throws when the database is unavailable', () => {
		assert.throws(() => getMailStoreService(undefined), /Database unavailable/);
	});

	test('builds a working service from a platform-shaped object', async () => {
		const platform = { env: { DB: fakeDb() } } as unknown as App.Platform;
		const service = getMailStoreService(platform);
		assert.equal(await service.emailExistsByProviderId('missing'), false);
	});
});

describe('legacy db-first facade', () => {
	test('insertEmail resolves a fresh thread (no reply chain, no subject match) and stores the row', async () => {
		const inserted: unknown[][] = [];
		const db = fakeDb();
		// Patch in an INSERT recorder without needing a full emails-table fake —
		// a draft with no replyToEmailId/inReplyTo skips every resolveThreadId
		// query, so the thread id is just the new email's own id.
		const recordingDb = createFakeD1(({ sql, args }) => {
			if (sql.startsWith('INSERT INTO emails')) {
				inserted.push(args);
				return [];
			}
			return [];
		});
		void db;

		const id = await insertEmail(recordingDb, {
			userId: 'user-1',
			direction: 'outbound',
			from: 'me@example.com',
			to: 'jane@example.com',
			subject: 'Draft',
			status: 'draft'
		});

		assert.equal(inserted.length, 1);
		assert.equal(inserted[0][0], id);
		// threadId (index 15) falls back to the new email's own id.
		assert.equal(inserted[0][15], id);
	});

	test('emailExistsByProviderId / updateEmailStatusByProviderId delegate to the repository', async () => {
		const db = fakeDb({ 'WHERE provider_id = ?': [{ id: 'email-1' }] });
		assert.equal(await emailExistsByProviderId(db, 'prov-1'), true);
		await assert.doesNotReject(updateEmailStatusByProviderId(db, 'prov-1', 'delivered', 'ok'));
	});

	test('deleteEmailsPermanently is a no-op when nothing is owned, keeping (db, bucket, userId, ids) order', async () => {
		const db = fakeDb({ 'SELECT id FROM emails WHERE user_id = ? AND id IN': [] });
		assert.equal(await deleteEmailsPermanently(db, undefined, 'user-1', ['a']), 0);
	});

	test('listMailbox returns an empty page when nothing matches', async () => {
		const db = fakeDb({ 'SELECT COUNT(*) AS count FROM (': [{ count: 0 }] });
		const page = await listMailbox(db, 'user-1', { view: 'inbox' });
		assert.deepEqual(page, { threads: [], total: 0, page: 1, pageCount: 1, pageSize: 25 });
	});
});
