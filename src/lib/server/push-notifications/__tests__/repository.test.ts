import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createFakeD1 } from '../../__tests__/support/fake-d1';
import { createD1PushSubscriptionRepository, MAX_SUBSCRIPTIONS_PER_USER } from '../repository';

type Row = {
	id: string;
	user_id: string;
	endpoint: string;
	p256dh: string;
	auth: string;
	expiration_time: number | null;
	user_agent: string | null;
	updated_at: string;
	rowid: number;
};

function makeRepo() {
	const rows: Row[] = [];
	let nextRowid = 1;
	let clock = 0;

	const db = createFakeD1(({ sql, args }) => {
		if (sql.startsWith('INSERT INTO push_subscriptions')) {
			const [id, userId, endpoint, p256dh, auth, expirationTime, userAgent] = args as [
				string,
				string,
				string,
				string,
				string,
				number | null,
				string | null
			];
			clock += 1;
			const updated_at = String(clock).padStart(4, '0');
			const existing = rows.find((row) => row.endpoint === endpoint);
			if (existing) {
				existing.user_id = userId;
				existing.p256dh = p256dh;
				existing.auth = auth;
				existing.expiration_time = expirationTime;
				existing.user_agent = userAgent;
				existing.updated_at = updated_at;
			} else {
				rows.push({
					id,
					user_id: userId,
					endpoint,
					p256dh,
					auth,
					expiration_time: expirationTime,
					user_agent: userAgent,
					updated_at,
					rowid: nextRowid++
				});
			}
			return [{}];
		}

		if (sql.startsWith('SELECT id FROM push_subscriptions')) {
			const [userId, keepEndpoint] = args as [string, string];
			return rows
				.filter((row) => row.user_id === userId)
				.sort((a, b) => {
					const keep = Number(b.endpoint === keepEndpoint) - Number(a.endpoint === keepEndpoint);
					if (keep !== 0) return keep;
					if (a.updated_at !== b.updated_at) return a.updated_at < b.updated_at ? 1 : -1;
					return b.rowid - a.rowid;
				});
		}

		if (sql.startsWith('DELETE FROM push_subscriptions WHERE id')) {
			const [id] = args as [string];
			const index = rows.findIndex((row) => row.id === id);
			if (index < 0) return [];
			rows.splice(index, 1);
			return [{}];
		}

		if (sql.startsWith('SELECT 1 AS registered')) {
			const [userId, endpoint] = args as [string, string];
			const found = rows.some((row) => row.user_id === userId && row.endpoint === endpoint);
			return found ? [{ registered: 1 }] : [];
		}

		if (sql.startsWith('DELETE FROM push_subscriptions WHERE user_id')) {
			const [userId, endpoint] = args as [string, string];
			const index = rows.findIndex((row) => row.user_id === userId && row.endpoint === endpoint);
			if (index < 0) return [];
			rows.splice(index, 1);
			return [{}];
		}

		if (sql.startsWith('SELECT endpoint, p256dh, auth, expiration_time')) {
			const [userId] = args as [string];
			return rows
				.filter((row) => row.user_id === userId)
				.sort((a, b) => (a.updated_at < b.updated_at ? 1 : b.rowid - a.rowid))
				.slice(0, MAX_SUBSCRIPTIONS_PER_USER);
		}

		if (sql.startsWith('DELETE FROM push_subscriptions WHERE endpoint')) {
			const [endpoint] = args as [string];
			const index = rows.findIndex((row) => row.endpoint === endpoint);
			if (index < 0) return [];
			rows.splice(index, 1);
			return [{}];
		}

		throw new Error(`Unhandled query in fake D1: ${sql}`);
	});

	return { repo: createD1PushSubscriptionRepository(db), rows };
}

describe('PushSubscriptionRepository', () => {
	test('upsert inserts, then updates in place on the same endpoint', async () => {
		const { repo, rows } = makeRepo();
		await repo.upsert({
			userId: 'u1',
			endpoint: 'https://push.example.com/a',
			p256dh: 'p1',
			auth: 'a1',
			expirationTime: null,
			userAgent: 'ua-1'
		});
		await repo.upsert({
			userId: 'u1',
			endpoint: 'https://push.example.com/a',
			p256dh: 'p2',
			auth: 'a2',
			expirationTime: 123,
			userAgent: 'ua-2'
		});

		assert.equal(rows.length, 1);
		assert.equal(rows[0].p256dh, 'p2');
		assert.equal(rows[0].expiration_time, 123);
	});

	test('capSubscriptions trims back to the cap, keeping the pinned endpoint first', async () => {
		const { repo } = makeRepo();
		for (let i = 0; i < MAX_SUBSCRIPTIONS_PER_USER + 2; i++) {
			await repo.upsert({
				userId: 'u1',
				endpoint: `https://push.example.com/${i}`,
				p256dh: 'p',
				auth: 'a',
				expirationTime: null,
				userAgent: null
			});
		}
		await repo.capSubscriptions('u1', 'https://push.example.com/0');

		const list = await repo.listByUser('u1');
		assert.equal(list.length, MAX_SUBSCRIPTIONS_PER_USER);
		assert.ok(list.some((row) => row.endpoint === 'https://push.example.com/0'));
	});

	test('hasSubscription / remove are scoped to the owning user', async () => {
		const { repo } = makeRepo();
		await repo.upsert({
			userId: 'u1',
			endpoint: 'https://push.example.com/a',
			p256dh: 'p',
			auth: 'a',
			expirationTime: null,
			userAgent: null
		});

		assert.equal(await repo.hasSubscription('u1', 'https://push.example.com/a'), true);
		assert.equal(await repo.hasSubscription('u2', 'https://push.example.com/a'), false);
		assert.equal(await repo.remove('u2', 'https://push.example.com/a'), false);
		assert.equal(await repo.remove('u1', 'https://push.example.com/a'), true);
		assert.equal(await repo.hasSubscription('u1', 'https://push.example.com/a'), false);
	});

	test('removeDead deletes by endpoint regardless of owner, and no-ops on an empty list', async () => {
		const { repo } = makeRepo();
		await repo.upsert({
			userId: 'u1',
			endpoint: 'https://push.example.com/a',
			p256dh: 'p',
			auth: 'a',
			expirationTime: null,
			userAgent: null
		});

		await repo.removeDead([]);
		assert.equal((await repo.listByUser('u1')).length, 1);

		await repo.removeDead(['https://push.example.com/a']);
		assert.equal((await repo.listByUser('u1')).length, 0);
	});
});
