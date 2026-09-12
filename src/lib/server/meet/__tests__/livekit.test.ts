import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createLiveKitClient } from '../livekit';

function base64urlDecode(part: string): Uint8Array {
	const padded = part.replace(/-/g, '+').replace(/_/g, '/').padEnd(part.length + ((4 - (part.length % 4)) % 4), '=');
	return new Uint8Array(Buffer.from(padded, 'base64'));
}

function decodeJson(part: string): Record<string, unknown> {
	return JSON.parse(Buffer.from(base64urlDecode(part)).toString('utf8'));
}

async function sign(data: string, secret: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign']
	);
	const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
	return Buffer.from(signature).toString('base64url');
}

describe('minting a LiveKit access token', () => {
	test('the JWT header and payload carry the expected shape', async () => {
		const client = createLiveKitClient('the-key', 'the-secret', 'wss://example.livekit.cloud');
		const jwt = await client.createAccessToken({ identity: 'user-1', name: 'Ada', room: 'room-1' });

		const [headerPart, payloadPart] = jwt.split('.');
		assert.deepEqual(decodeJson(headerPart), { alg: 'HS256', typ: 'JWT' });

		const payload = decodeJson(payloadPart);
		assert.equal(payload.iss, 'the-key');
		assert.equal(payload.sub, 'user-1');
		assert.equal(payload.name, 'Ada');
		assert.equal(typeof payload.exp, 'number');
		assert.equal(typeof payload.nbf, 'number');
		assert.ok((payload.exp as number) > (payload.nbf as number));
		assert.deepEqual(payload.video, {
			roomJoin: true,
			room: 'room-1',
			canPublish: true,
			canSubscribe: true,
			canPublishData: true,
			canUpdateOwnMetadata: true
		});
	});

	test('exp reflects a custom ttlSeconds', async () => {
		const client = createLiveKitClient('key', 'secret', 'wss://example.livekit.cloud');
		const jwt = await client.createAccessToken({ identity: 'user-1', room: 'room-1', ttlSeconds: 60 });

		const [, payloadPart] = jwt.split('.');
		const payload = decodeJson(payloadPart);
		assert.equal((payload.exp as number) - (payload.nbf as number), 60);
	});

	test('the signature verifies against the configured secret', async () => {
		const client = createLiveKitClient('key', 'super-secret', 'wss://example.livekit.cloud');
		const jwt = await client.createAccessToken({ identity: 'user-1', room: 'room-1' });

		const [headerPart, payloadPart, signaturePart] = jwt.split('.');
		const expected = await sign(`${headerPart}.${payloadPart}`, 'super-secret');
		assert.equal(signaturePart, expected);

		const wrong = await sign(`${headerPart}.${payloadPart}`, 'wrong-secret');
		assert.notEqual(signaturePart, wrong);
	});

	test('refuses to mint without full configuration', () => {
		assert.throws(() => createLiveKitClient('', 'secret', 'wss://example.livekit.cloud'));
		assert.throws(() => createLiveKitClient('key', '', 'wss://example.livekit.cloud'));
		assert.throws(() => createLiveKitClient('key', 'secret', ''));
	});
});
