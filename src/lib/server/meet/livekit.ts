/**
 * Minimal LiveKit access-token minting, implemented with Web Crypto so it
 * runs on Workers without the `livekit-server-sdk` dependency.
 *
 * LiveKit rooms are created implicitly on first join, so this is the entire
 * server-side surface for v1 — no LiveKit REST calls, just a signed JWT.
 *
 * Docs: https://docs.livekit.io/home/get-started/authentication/
 */

export class LiveKitError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'LiveKitError';
	}
}

type AccessTokenOptions = {
	identity: string;
	name?: string;
	room: string;
	/** How long the token is valid to establish the *initial* connection. */
	ttlSeconds?: number;
};

export type LiveKitClient = {
	/** wss:// URL the browser connects to directly. */
	url: string;
	createAccessToken(options: AccessTokenOptions): Promise<string>;
};

export function createLiveKitClient(apiKey: string, apiSecret: string, url: string): LiveKitClient {
	if (!apiKey || !apiSecret || !url) {
		throw new LiveKitError('LiveKit is not configured');
	}

	return {
		url,
		async createAccessToken({ identity, name, room, ttlSeconds = 900 }) {
			const now = Math.floor(Date.now() / 1000);
			const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
			const payload = base64url(
				JSON.stringify({
					iss: apiKey,
					sub: identity,
					name,
					nbf: now,
					exp: now + ttlSeconds,
					video: {
						roomJoin: true,
						room,
						canPublish: true,
						canSubscribe: true,
						canPublishData: true,
						// Without this, a participant's own setAttributes() calls (deafened badge,
						// future host-role reads) are silently rejected by the server.
						canUpdateOwnMetadata: true
					}
				})
			);
			const signature = await sign(`${header}.${payload}`, apiSecret);
			return `${header}.${payload}.${signature}`;
		}
	};
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
	return base64url(signature);
}

function base64url(input: string | ArrayBuffer): string {
	const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : new Uint8Array(input);
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
