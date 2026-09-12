import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { D1Database } from '@cloudflare/workers-types';
import { createFakeD1 } from '../../__tests__/support/fake-d1';
import { getPushNotificationService, scheduleNewMailNotification } from '../index';

describe('getPushNotificationService', () => {
	test('throws when the database is unavailable', () => {
		assert.throws(() => getPushNotificationService(undefined), /Database unavailable/);
	});

	test('builds a working service from a platform-shaped object', async () => {
		const db = createFakeD1(() => []);
		const platform = { env: { DB: db } } as unknown as App.Platform;
		const service = getPushNotificationService(platform);
		assert.equal(await service.hasSubscription('u1', 'https://push.example.com/a'), false);
	});
});

describe('scheduleNewMailNotification', () => {
	test('hands delivery to the runtime background scheduler, without a valid VAPID config', async () => {
		let scheduled: Promise<void> | null = null;
		await scheduleNewMailNotification(
			{
				DB: {} as D1Database,
				waitUntil: (promise) => (scheduled = promise)
			},
			{ emailId: 'mail-1', userId: 'user-1', from: 'sender@example.com', subject: 'Hello' }
		);
		assert.ok(scheduled);
		await scheduled;
	});

	test('awaits delivery directly when no waitUntil is provided', async () => {
		await assert.doesNotReject(() =>
			scheduleNewMailNotification(
				{ DB: {} as D1Database },
				{ emailId: 'mail-1', userId: 'user-1', from: 'sender@example.com', subject: 'Hello' }
			)
		);
	});
});
