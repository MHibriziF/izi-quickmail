import { createECDH } from 'node:crypto';
import webpush from 'web-push';
import type { PushSubscriptionRepository } from './repository';

const MAX_ENDPOINT_LENGTH = 2048;
const MAX_KEY_LENGTH = 512;
const MAX_USER_AGENT_LENGTH = 512;
const PUSH_REQUEST_TIMEOUT_MS = 10_000;
const BASE64URL = /^[A-Za-z0-9_-]+={0,2}$/;

export type PushSubscriptionInput = {
	endpoint: string;
	expirationTime: number | null;
	keys: {
		p256dh: string;
		auth: string;
	};
};

export type NewMailNotificationInput = {
	emailId: string;
	userId: string;
	from: string;
	subject: string;
};

export type NewMailPushPayload = {
	title: string;
	body: string;
	tag: string;
	url: string;
};

export type VapidConfiguration = {
	publicKey: string;
	privateKey: string;
	subject: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function decodeBase64Url(value: unknown): Uint8Array | null {
	if (
		typeof value !== 'string' ||
		value.length === 0 ||
		value.length > MAX_KEY_LENGTH ||
		!BASE64URL.test(value)
	) {
		return null;
	}

	const unpadded = value.replaceAll('=', '');
	if (unpadded.length % 4 === 1) return null;
	const base64 = unpadded.replaceAll('-', '+').replaceAll('_', '/');
	const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);

	try {
		const binary = atob(padded);
		return Uint8Array.from(binary, (character) => character.charCodeAt(0));
	} catch {
		return null;
	}
}

function validPublicKey(value: unknown): value is string {
	const decoded = decodeBase64Url(value);
	return decoded?.byteLength === 65 && decoded[0] === 0x04;
}

function validAuthSecret(value: unknown): value is string {
	return decodeBase64Url(value)?.byteLength === 16;
}

function validVapidKeyPair(publicKey: string, privateKey: string): boolean {
	const publicBytes = decodeBase64Url(publicKey);
	const privateBytes = decodeBase64Url(privateKey);
	if (publicBytes?.byteLength !== 65 || publicBytes[0] !== 0x04 || privateBytes?.byteLength !== 32) {
		return false;
	}

	try {
		const ecdh = createECDH('prime256v1');
		ecdh.setPrivateKey(privateBytes);
		const derivedPublicKey = ecdh.getPublicKey();
		return (
			derivedPublicKey.byteLength === publicBytes.byteLength &&
			derivedPublicKey.every((byte, index) => byte === publicBytes[index])
		);
	} catch {
		return false;
	}
}

function validEndpoint(value: unknown): value is string {
	if (typeof value !== 'string') return false;
	const endpoint = value.trim();
	if (!endpoint || endpoint.length > MAX_ENDPOINT_LENGTH) return false;

	try {
		const url = new URL(endpoint);
		return url.protocol === 'https:' && !url.username && !url.password;
	} catch {
		return false;
	}
}

/** Treat browser subscription JSON as untrusted input before storing it. */
export function parsePushSubscription(value: unknown): PushSubscriptionInput | null {
	if (!isRecord(value) || typeof value.endpoint !== 'string' || !isRecord(value.keys)) {
		return null;
	}

	if (!validEndpoint(value.endpoint)) return null;
	const endpoint = value.endpoint.trim();

	if (!validPublicKey(value.keys.p256dh) || !validAuthSecret(value.keys.auth)) return null;

	const expirationTime = value.expirationTime ?? null;
	if (
		expirationTime !== null &&
		(typeof expirationTime !== 'number' || !Number.isFinite(expirationTime) || expirationTime < 0)
	) {
		return null;
	}

	return {
		endpoint,
		expirationTime,
		keys: { p256dh: value.keys.p256dh, auth: value.keys.auth }
	};
}

export function readVapidConfiguration(env: {
	VAPID_PUBLIC_KEY?: string;
	VAPID_PRIVATE_KEY?: string;
	VAPID_SUBJECT?: string;
}): VapidConfiguration | null {
	const publicKey = env.VAPID_PUBLIC_KEY?.trim();
	const privateKey = env.VAPID_PRIVATE_KEY?.trim();
	const subject = env.VAPID_SUBJECT?.trim();
	if (!publicKey || !privateKey || !subject || !validVapidKeyPair(publicKey, privateKey)) return null;
	try {
		const subjectUrl = new URL(subject);
		if (subjectUrl.protocol !== 'mailto:' && subjectUrl.protocol !== 'https:') return null;
		if (subjectUrl.protocol === 'mailto:' && !subjectUrl.pathname.trim()) return null;
	} catch {
		return null;
	}
	return { publicKey, privateKey, subject };
}

function truncate(value: string, max: number): string {
	const normalized = value.trim().replace(/\s+/g, ' ');
	return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1)}…`;
}

export function buildNewMailPayload(input: NewMailNotificationInput): NewMailPushPayload {
	return {
		title: truncate(input.subject || '(no subject)', 120) || '(no subject)',
		body: `From ${truncate(input.from || 'Unknown sender', 160) || 'Unknown sender'}`,
		tag: `quickinbox-${input.emailId}`,
		url: `/mail/${encodeURIComponent(input.emailId)}`
	};
}

export function pushErrorStatus(error: unknown): number | null {
	if (!isRecord(error) || typeof error.statusCode !== 'number') return null;
	return error.statusCode;
}

export type PushNotificationService = {
	saveSubscription(
		userId: string,
		subscription: PushSubscriptionInput,
		userAgent?: string | null
	): Promise<void>;
	hasSubscription(userId: string, endpoint: string): Promise<boolean>;
	removeSubscription(userId: string, endpoint: string): Promise<boolean>;
};

export function createPushNotificationService(repo: PushSubscriptionRepository): PushNotificationService {
	return {
		async saveSubscription(userId, subscription, userAgent) {
			await repo.upsert({
				userId,
				endpoint: subscription.endpoint,
				p256dh: subscription.keys.p256dh,
				auth: subscription.keys.auth,
				expirationTime: subscription.expirationTime,
				userAgent: userAgent?.slice(0, MAX_USER_AGENT_LENGTH) ?? null
			});
			await repo.capSubscriptions(userId, subscription.endpoint);
		},

		async hasSubscription(userId, endpoint) {
			if (!validEndpoint(endpoint)) return false;
			return repo.hasSubscription(userId, endpoint.trim());
		},

		removeSubscription: (userId, endpoint) => repo.remove(userId, endpoint)
	};
}

async function deliverNewMailNotification(
	repo: PushSubscriptionRepository,
	vapid: VapidConfiguration | null,
	input: NewMailNotificationInput
): Promise<void> {
	if (!vapid) return;

	const subscriptions = await repo.listByUser(input.userId);
	if (subscriptions.length === 0) return;

	webpush.setVapidDetails(vapid.subject, vapid.publicKey, vapid.privateKey);
	const payload = JSON.stringify(buildNewMailPayload(input));
	const deadEndpoints: string[] = [];

	await Promise.all(
		subscriptions.map(async (subscription) => {
			try {
				await webpush.sendNotification(
					{
						endpoint: subscription.endpoint,
						expirationTime: subscription.expiration_time,
						keys: { p256dh: subscription.p256dh, auth: subscription.auth }
					},
					payload,
					{ TTL: 300, urgency: 'high', timeout: PUSH_REQUEST_TIMEOUT_MS }
				);
			} catch (error) {
				const status = pushErrorStatus(error);
				if (status === 404 || status === 410) {
					deadEndpoints.push(subscription.endpoint);
				} else {
					console.error(
						'Failed to send new-mail push notification',
						status ?? (error instanceof Error ? error.message : 'Unknown error')
					);
				}
			}
		})
	);

	await repo.removeDead(deadEndpoints);
}

/**
 * Notify every browser registered to the recipient. Push failures never undo a
 * successfully stored email; expired endpoints are removed automatically.
 */
export async function notifyNewMail(
	repo: PushSubscriptionRepository,
	vapid: VapidConfiguration | null,
	input: NewMailNotificationInput
): Promise<void> {
	try {
		await deliverNewMailNotification(repo, vapid, input);
	} catch (error) {
		console.error(
			'Failed to deliver new-mail push notifications',
			error instanceof Error ? error.message : 'Unknown error'
		);
	}
}
