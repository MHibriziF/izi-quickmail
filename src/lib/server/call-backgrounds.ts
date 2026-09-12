import type { D1Database, R2Bucket } from '@cloudflare/workers-types';
import { MAX_CALL_BACKGROUND_BYTES, MAX_CALL_BACKGROUNDS_PER_USER } from './constants';

export type CallBackgroundMeta = {
	id: string;
	user_id: string;
	content_type: string;
	size_bytes: number;
	created_at: string;
};

type StoredCallBackgroundRow = CallBackgroundMeta & { storage_key: string };

export async function insertCallBackground(
	db: D1Database,
	bucket: R2Bucket,
	userId: string,
	input: { filename: string; type: string; bytes: Uint8Array }
): Promise<CallBackgroundMeta> {
	if (!input.type.startsWith('image/')) {
		throw new Error('Backgrounds must be an image');
	}
	if (input.bytes.byteLength > MAX_CALL_BACKGROUND_BYTES) {
		const limitMb = MAX_CALL_BACKGROUND_BYTES / (1024 * 1024);
		throw new Error(`Image exceeds ${limitMb}MB limit`);
	}

	await trimOldestIfAtCap(db, bucket, userId);

	const id = crypto.randomUUID();
	const storageKey = buildStorageKey(userId, id, input.filename);

	await bucket.put(storageKey, input.bytes, {
		httpMetadata: { contentType: input.type },
		customMetadata: { filename: input.filename }
	});

	await db
		.prepare(
			`INSERT INTO call_backgrounds (id, user_id, storage_key, content_type, size_bytes)
			 VALUES (?, ?, ?, ?, ?)`
		)
		.bind(id, userId, storageKey, input.type, input.bytes.byteLength)
		.run();

	const row = await db
		.prepare(`SELECT id, user_id, content_type, size_bytes, created_at FROM call_backgrounds WHERE id = ?`)
		.bind(id)
		.first<CallBackgroundMeta>();

	if (!row) throw new Error('Failed to save background');
	return row;
}

async function trimOldestIfAtCap(db: D1Database, bucket: R2Bucket, userId: string): Promise<void> {
	const { results } = await db
		.prepare(
			`SELECT id, storage_key FROM call_backgrounds
			 WHERE user_id = ? ORDER BY created_at ASC`
		)
		.bind(userId)
		.all<{ id: string; storage_key: string }>();

	if (results.length < MAX_CALL_BACKGROUNDS_PER_USER) return;

	const oldest = results[0];
	await bucket.delete(oldest.storage_key);
	await db.prepare(`DELETE FROM call_backgrounds WHERE id = ?`).bind(oldest.id).run();
}

export async function listCallBackgrounds(db: D1Database, userId: string): Promise<CallBackgroundMeta[]> {
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
}

export async function getCallBackgroundForUser(
	db: D1Database,
	userId: string,
	id: string
): Promise<StoredCallBackgroundRow | null> {
	const row = await db
		.prepare(
			`SELECT id, user_id, storage_key, content_type, size_bytes, created_at
			 FROM call_backgrounds
			 WHERE id = ? AND user_id = ?`
		)
		.bind(id, userId)
		.first<StoredCallBackgroundRow>();

	return row ?? null;
}

export async function readCallBackgroundBytes(
	bucket: R2Bucket,
	background: StoredCallBackgroundRow
): Promise<Uint8Array | null> {
	const object = await bucket.get(background.storage_key);
	if (!object) return null;
	return new Uint8Array(await object.arrayBuffer());
}

export async function deleteCallBackground(
	db: D1Database,
	bucket: R2Bucket,
	userId: string,
	id: string
): Promise<boolean> {
	const row = await getCallBackgroundForUser(db, userId, id);
	if (!row) return false;

	await bucket.delete(row.storage_key);
	await db.prepare(`DELETE FROM call_backgrounds WHERE id = ?`).bind(id).run();
	return true;
}

function buildStorageKey(userId: string, backgroundId: string, filename: string): string {
	const safeName = filename.replace(/[^\w.\-()+ ]+/g, '_').slice(0, 120) || 'background';
	return `call-backgrounds/${userId}/${backgroundId}/${safeName}`;
}
