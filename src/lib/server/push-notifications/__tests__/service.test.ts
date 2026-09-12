import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import webpush from 'web-push';
import type { PushSubscriptionRepository } from '../repository';
import {
	buildNewMailPayload,
	createPushNotificationService,
	notifyNewMail,
	parsePushSubscription,
	pushErrorStatus,
	readVapidConfiguration
} from '../service';

const vapidKeys = webpush.generateVAPIDKeys();

const validSubscription = {
	endpoint: 'https://push.example.com/subscriptions/device-1',
	expirationTime: null,
	keys: {
		p256dh: vapidKeys.publicKey,
		auth: 'AAAAAAAAAAAAAAAAAAAAAA'
	}
};

function fakeRepo(overrides: Partial<PushSubscriptionRepository> = {}): PushSubscriptionRepository {
	return {
		upsert: async () => {},
		capSubscriptions: async () => {},
		hasSubscription: async () => false,
		remove: async () => false,
		listByUser: async () => [],
		removeDead: async () => {},
		...overrides
	};
}

describe('push subscription parsing', () => {
	test('accepts browser subscription JSON', () => {
		assert.deepEqual(parsePushSubscription(validSubscription), validSubscription);
	});

	test('rejects insecure endpoints and malformed keys', () => {
		assert.equal(
			parsePushSubscription({ ...validSubscription, endpoint: 'http://push.example.com/device' }),
			null
		);
		assert.equal(
			parsePushSubscription({
				...validSubscription,
				keys: { ...validSubscription.keys, auth: 'not base64!' }
			}),
			null
		);
		assert.equal(parsePushSubscription({ endpoint: validSubscription.endpoint }), null);
		assert.equal(
			parsePushSubscription({
				...validSubscription,
				keys: { ...validSubscription.keys, p256dh: validSubscription.keys.p256dh.slice(1) }
			}),
			null
		);
	});

	test('rejects a malformed expirationTime', () => {
		assert.equal(parsePushSubscription({ ...validSubscription, expirationTime: 'soon' }), null);
		assert.equal(parsePushSubscription({ ...validSubscription, expirationTime: -1 }), null);
	});
});

describe('VAPID configuration', () => {
	test('requires all keys and a contact URI', () => {
		assert.deepEqual(
			readVapidConfiguration({
				VAPID_PUBLIC_KEY: vapidKeys.publicKey,
				VAPID_PRIVATE_KEY: vapidKeys.privateKey,
				VAPID_SUBJECT: 'mailto:admin@example.com'
			}),
			{ ...vapidKeys, subject: 'mailto:admin@example.com' }
		);
		assert.equal(
			readVapidConfiguration({
				VAPID_PUBLIC_KEY: vapidKeys.publicKey,
				VAPID_PRIVATE_KEY: vapidKeys.privateKey,
				VAPID_SUBJECT: 'admin@example.com'
			}),
			null
		);
		assert.equal(
			readVapidConfiguration({
				VAPID_PUBLIC_KEY: vapidKeys.publicKey,
				VAPID_PRIVATE_KEY: vapidKeys.privateKey,
				VAPID_SUBJECT: 'mailto:'
			}),
			null
		);
	});

	test('rejects placeholders and mismatched key pairs', () => {
		assert.equal(
			readVapidConfiguration({
				VAPID_PUBLIC_KEY: 'REPLACE_WITH_YOUR_VAPID_PUBLIC_KEY',
				VAPID_PRIVATE_KEY: 'REPLACE_WITH_YOUR_VAPID_PRIVATE_KEY',
				VAPID_SUBJECT: 'mailto:admin@example.com'
			}),
			null
		);

		const otherKeys = webpush.generateVAPIDKeys();
		assert.equal(
			readVapidConfiguration({
				VAPID_PUBLIC_KEY: vapidKeys.publicKey,
				VAPID_PRIVATE_KEY: otherKeys.privateKey,
				VAPID_SUBJECT: 'https://example.com/push-contact'
			}),
			null
		);
	});
});

describe('new-mail push payloads', () => {
	test('contain no message body and link to the stored email', () => {
		const payload = buildNewMailPayload({
			emailId: 'mail/id',
			userId: 'user-1',
			from: 'Ada <ada@example.com>',
			subject: 'Project update'
		});

		assert.deepEqual(payload, {
			title: 'Project update',
			body: 'From Ada <ada@example.com>',
			tag: 'quickinbox-mail/id',
			url: '/mail/mail%2Fid'
		});
		assert.equal(JSON.stringify(payload).includes('message body'), false);
	});

	test('recognizes expired subscription responses', () => {
		assert.equal(pushErrorStatus({ statusCode: 410 }), 410);
		assert.equal(pushErrorStatus(new Error('network error')), null);
	});
});

describe('createPushNotificationService', () => {
	test('saveSubscription upserts then caps, in that order', async () => {
		const calls: string[] = [];
		const service = createPushNotificationService(
			fakeRepo({
				upsert: async () => {
					calls.push('upsert');
				},
				capSubscriptions: async () => {
					calls.push('cap');
				}
			})
		);

		await service.saveSubscription('u1', validSubscription, 'a'.repeat(600));
		assert.deepEqual(calls, ['upsert', 'cap']);
	});

	test('hasSubscription rejects a malformed endpoint before touching the repository', async () => {
		const service = createPushNotificationService(
			fakeRepo({
				hasSubscription: async () => {
					throw new Error('must not be called');
				}
			})
		);
		assert.equal(await service.hasSubscription('u1', 'not-a-url'), false);
	});

	test('hasSubscription / removeSubscription pass through to the repository', async () => {
		const service = createPushNotificationService(
			fakeRepo({
				hasSubscription: async (userId, endpoint) => userId === 'u1' && endpoint === validSubscription.endpoint,
				remove: async (userId, endpoint) => userId === 'u1' && endpoint === validSubscription.endpoint
			})
		);

		assert.equal(await service.hasSubscription('u1', validSubscription.endpoint), true);
		assert.equal(await service.removeSubscription('u1', validSubscription.endpoint), true);
		assert.equal(await service.removeSubscription('u2', validSubscription.endpoint), false);
	});
});

describe('notifyNewMail', () => {
	const input = { emailId: 'mail-1', userId: 'user-1', from: 'sender@example.com', subject: 'Hello' };

	test('does nothing without a valid VAPID configuration', async () => {
		const service = fakeRepo({
			listByUser: async () => {
				throw new Error('must not be called');
			}
		});
		await assert.doesNotReject(() => notifyNewMail(service, null, input));
	});

	test('does nothing when the recipient has no subscriptions', async () => {
		let removed: string[] | null = null;
		const repo = fakeRepo({
			listByUser: async () => [],
			removeDead: async (endpoints) => {
				removed = endpoints;
			}
		});
		await notifyNewMail(repo, { ...vapidKeys, subject: 'mailto:admin@example.com' }, input);
		assert.equal(removed, null);
	});

	test('swallows delivery errors instead of throwing', async () => {
		const repo = fakeRepo({
			listByUser: async () => {
				throw new Error('boom');
			}
		});
		await assert.doesNotReject(() =>
			notifyNewMail(repo, { ...vapidKeys, subject: 'mailto:admin@example.com' }, input)
		);
	});

});
