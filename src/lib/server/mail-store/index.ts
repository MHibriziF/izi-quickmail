import type { D1Database, R2Bucket } from '@cloudflare/workers-types';
import type { DeliveryStatus } from '$lib/types';
import { resolveThreadId } from './threads';
import { createD1MailStoreRepository } from './repository';
import { createMailStoreService, type InsertEmailInput, type MailStoreService } from './service';

export type { MailStoreRepository, MailboxQuery, MailFlagUpdate } from './repository';
export {
	createMailStoreService,
	encodeMailboxCursor,
	type MailStoreService,
	type InsertEmailInput,
	type DraftInput
} from './service';
export { createD1MailStoreRepository } from './repository';

type PlatformLike = App.Platform | undefined | null;

function serviceForDb(db: D1Database): MailStoreService {
	return createMailStoreService({
		repo: createD1MailStoreRepository(db),
		resolveThread: (userId, input) => resolveThreadId(db, userId, input)
	});
}

/** Composition root for routes — mirrors `getDomainsService`/`getMeetingsService`. */
export function getMailStoreService(platform: PlatformLike): MailStoreService {
	const db = platform?.env.DB;
	if (!db) throw new Error('Database unavailable');
	return serviceForDb(db);
}

/*
 * The functions below exist only for the peer server modules (outbox,
 * cloudflare-inbound, inbound, cleanup, mailbox) that receive a `db` handed
 * down from their own callers rather than `platform`. They are a
 * deliberately thin, `db`-first facade over the service, matching each
 * function's exact prior signature — routes are the actual target of the
 * "no direct DB access in a route file" rule, not these peer modules.
 */

export function insertEmail(db: D1Database, input: InsertEmailInput) {
	return serviceForDb(db).insertEmail(input);
}

export function emailExistsByProviderId(db: D1Database, providerId: string) {
	return serviceForDb(db).emailExistsByProviderId(providerId);
}

export function updateEmailStatusByProviderId(
	db: D1Database,
	providerId: string,
	status: DeliveryStatus,
	detail?: string | null
) {
	return serviceForDb(db).updateEmailStatusByProviderId(providerId, status, detail);
}

export function deleteEmailsPermanently(
	db: D1Database,
	bucket: R2Bucket | undefined,
	userId: string,
	ids: string[]
) {
	return serviceForDb(db).deleteEmailsPermanently(userId, bucket, ids);
}

export function listMailbox(db: D1Database, userId: string, query: Parameters<MailStoreService['listMailbox']>[1]) {
	return serviceForDb(db).listMailbox(userId, query);
}
