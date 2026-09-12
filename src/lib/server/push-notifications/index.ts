import type { D1Database } from '@cloudflare/workers-types';
import { createD1PushSubscriptionRepository } from './repository';
import {
	createPushNotificationService,
	notifyNewMail as deliverNewMail,
	readVapidConfiguration,
	type NewMailNotificationInput,
	type PushNotificationService
} from './service';

export type { PushSubscriptionRepository } from './repository';
export { MAX_SUBSCRIPTIONS_PER_USER } from './repository';
export {
	buildNewMailPayload,
	parsePushSubscription,
	pushErrorStatus,
	readVapidConfiguration,
	type NewMailNotificationInput,
	type NewMailPushPayload,
	type PushNotificationService,
	type PushSubscriptionInput,
	type VapidConfiguration
} from './service';

export type PushNotificationEnv = {
	DB: D1Database;
	VAPID_PUBLIC_KEY?: string;
	VAPID_PRIVATE_KEY?: string;
	VAPID_SUBJECT?: string;
	waitUntil?: (promise: Promise<void>) => void;
};

type PlatformLike = App.Platform | undefined | null;

/** Composition root for routes — mirrors `getAuthService`/`getApiTokenService`. */
export function getPushNotificationService(platform: PlatformLike): PushNotificationService {
	const db = platform?.env.DB;
	if (!db) throw new Error('Database unavailable');
	return createPushNotificationService(createD1PushSubscriptionRepository(db));
}

/**
 * The Cloudflare email-routing worker and the Resend inbound webhook hand
 * down a bare env object rather than SvelteKit's `platform`, since they run
 * outside the request lifecycle that provides it.
 */
export async function notifyNewMail(env: PushNotificationEnv, input: NewMailNotificationInput): Promise<void> {
	const vapid = readVapidConfiguration(env);
	await deliverNewMail(createD1PushSubscriptionRepository(env.DB), vapid, input);
}

/** Schedule best-effort delivery without holding up inbound-provider acknowledgement. */
export async function scheduleNewMailNotification(
	env: PushNotificationEnv,
	input: NewMailNotificationInput
): Promise<void> {
	const task = notifyNewMail(env, input);
	if (env.waitUntil) {
		env.waitUntil(task);
		return;
	}
	await task;
}
