import type { D1Database, R2Bucket } from '@cloudflare/workers-types';

export type CallBackgroundMeta = {
	id: string;
	user_id: string;
	content_type: string;
	size_bytes: number;
	created_at: string;
};

export type StoredCallBackground = CallBackgroundMeta & { storage_key: string };

export type NewCallBackground = {
	id: string;
	userId: string;
	storageKey: string;
	contentType: string;
	sizeBytes: number;
	bytes: Uint8Array;
	filename: string;
};

/**
 * Raw D1 + R2 access for call backgrounds — a background's row and blob share
 * one lifecycle (created and deleted together), so this repository owns
 * both. No validation, no eviction policy — see `../service.ts` for those.
 */
export type CallBackgroundsRepository = {
	listForUser(userId: string): Promise<CallBackgroundMeta[]>;
	/** Oldest first, with the storage key the eviction policy needs to delete a blob. */
	listOldestFirstForUser(userId: string): Promise<Array<{ id: string; storage_key: string }>>;
	getForUser(userId: string, id: string): Promise<StoredCallBackground | null>;
	insert(input: NewCallBackground): Promise<CallBackgroundMeta>;
	remove(id: string, storageKey: string): Promise<void>;
	readBytes(storageKey: string): Promise<Uint8Array | null>;
}

/**
 * `getBucket` is lazy so listing/reading rows never requires R2 to be bound —
 * only `insert`/`remove`/`readBytes` actually touch the bucket, matching the
 * routes that historically only guarded on `ATTACHMENTS` where they needed it.
 */
export function createD1CallBackgroundsRepository(
	db: D1Database,
	getBucket: () => R2Bucket
): CallBackgroundsRepository {
	return {
		async listForUser(userId) {
			const { results } = await db
				.prepare(
					`SELECT id, user_id, content_type, size_bytes, created_at
					 FROM call_backgrounds
					 WHERE user_id = ?
					 ORDER BY created_at DESC`
				)
				.bind(userId)
				.all<CallBackgroundMeta>();
			return results;
		},

		async listOldestFirstForUser(userId) {
			const { results } = await db
				.prepare(
					`SELECT id, storage_key FROM call_backgrounds
					 WHERE user_id = ? ORDER BY created_at ASC`
				)
				.bind(userId)
				.all<{ id: string; storage_key: string }>();
			return results;
		},

		async getForUser(userId, id) {
			const row = await db
				.prepare(
					`SELECT id, user_id, storage_key, content_type, size_bytes, created_at
					 FROM call_backgrounds
					 WHERE id = ? AND user_id = ?`
				)
				.bind(id, userId)
				.first<StoredCallBackground>();
			return row ?? null;
		},

		async insert(input) {
			const bucket = getBucket();
			await bucket.put(input.storageKey, input.bytes, {
				httpMetadata: { contentType: input.contentType },
				customMetadata: { filename: input.filename }
			});

			try {
				await db
					.prepare(
						`INSERT INTO call_backgrounds (id, user_id, storage_key, content_type, size_bytes)
						 VALUES (?, ?, ?, ?, ?)`
					)
					.bind(input.id, input.userId, input.storageKey, input.contentType, input.sizeBytes)
					.run();

				const row = await db
					.prepare(`SELECT id, user_id, content_type, size_bytes, created_at FROM call_backgrounds WHERE id = ?`)
					.bind(input.id)
					.first<CallBackgroundMeta>();

				if (!row) throw new Error('Failed to save background');
				return row;
			} catch (error) {
				// The row never landed (or came back missing), so don't leave the blob
				// behind as an orphan nothing will ever reference or clean up.
				await bucket.delete(input.storageKey);
				throw error;
			}
		},

		async remove(id, storageKey) {
			await getBucket().delete(storageKey);
			await db.prepare(`DELETE FROM call_backgrounds WHERE id = ?`).bind(id).run();
		},

		async readBytes(storageKey) {
			const object = await getBucket().get(storageKey);
			if (!object) return null;
			return new Uint8Array(await object.arrayBuffer());
		}
	};
}
