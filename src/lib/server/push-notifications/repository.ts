import type { D1Database } from '@cloudflare/workers-types';

export const MAX_SUBSCRIPTIONS_PER_USER = 10;

export type StoredPushSubscription = {
	endpoint: string;
	p256dh: string;
	auth: string;
	expiration_time: number | null;
};

export type PushSubscriptionRepository = {
	upsert(row: {
		userId: string;
		endpoint: string;
		p256dh: string;
		auth: string;
		expirationTime: number | null;
		userAgent: string | null;
	}): Promise<void>;
	/** Deletes everything past the newest `MAX_SUBSCRIPTIONS_PER_USER`, with `keepEndpoint` pinned first. */
	capSubscriptions(userId: string, keepEndpoint: string): Promise<void>;
	hasSubscription(userId: string, endpoint: string): Promise<boolean>;
	remove(userId: string, endpoint: string): Promise<boolean>;
	listByUser(userId: string): Promise<StoredPushSubscription[]>;
	removeDead(endpoints: string[]): Promise<void>;
};

export function createD1PushSubscriptionRepository(db: D1Database): PushSubscriptionRepository {
	return {
		async upsert(row) {
			await db
				.prepare(
					`INSERT INTO push_subscriptions (
						id, user_id, endpoint, p256dh, auth, expiration_time, user_agent
					) VALUES (?, ?, ?, ?, ?, ?, ?)
					ON CONFLICT(endpoint) DO UPDATE SET
						user_id = excluded.user_id,
						p256dh = excluded.p256dh,
						auth = excluded.auth,
						expiration_time = excluded.expiration_time,
						user_agent = excluded.user_agent,
						updated_at = datetime('now')`
				)
				.bind(
					crypto.randomUUID(),
					row.userId,
					row.endpoint,
					row.p256dh,
					row.auth,
					row.expirationTime,
					row.userAgent
				)
				.run();
		},

		async capSubscriptions(userId, keepEndpoint) {
			const { results } = await db
				.prepare(
					`SELECT id FROM push_subscriptions
					 WHERE user_id = ?
					 ORDER BY (endpoint = ?) DESC, updated_at DESC, rowid DESC`
				)
				.bind(userId, keepEndpoint)
				.all<{ id: string }>();

			const extraIds = results.slice(MAX_SUBSCRIPTIONS_PER_USER).map((row) => row.id);
			if (extraIds.length === 0) return;

			await db.batch(
				extraIds.map((id) => db.prepare('DELETE FROM push_subscriptions WHERE id = ?').bind(id))
			);
		},

		async hasSubscription(userId, endpoint) {
			const row = await db
				.prepare('SELECT 1 AS registered FROM push_subscriptions WHERE user_id = ? AND endpoint = ?')
				.bind(userId, endpoint)
				.first<{ registered: number }>();
			return row?.registered === 1;
		},

		async remove(userId, endpoint) {
			const result = await db
				.prepare('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?')
				.bind(userId, endpoint)
				.run();
			return (result.meta?.changes ?? 0) > 0;
		},

		async listByUser(userId) {
			const { results } = await db
				.prepare(
					`SELECT endpoint, p256dh, auth, expiration_time
					 FROM push_subscriptions WHERE user_id = ?
					 ORDER BY updated_at DESC, rowid DESC
					 LIMIT ?`
				)
				.bind(userId, MAX_SUBSCRIPTIONS_PER_USER)
				.all<StoredPushSubscription>();
			return results;
		},

		async removeDead(endpoints) {
			if (endpoints.length === 0) return;
			await db.batch(
				endpoints.map((endpoint) =>
					db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').bind(endpoint)
				)
			);
		}
	};
}
