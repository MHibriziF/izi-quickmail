import type { ApiTokenSummary, User } from '$lib/types';
import { hashToken } from '../util/crypto';
import { isApiScope, type ApiScope, type ApiTokenRepository } from './repository';

/** New keys use `qi_live_`. Existing `qm_live_` keys from before the rename still authenticate. */
const TOKEN_PREFIX = 'qi_live_';
const LEGACY_TOKEN_PREFIX = 'qm_live_';
const TOKEN_PREFIXES = [TOKEN_PREFIX, LEGACY_TOKEN_PREFIX] as const;
const MAX_TOKEN_LENGTH = 256;
const LAST_USED_THROTTLE_MS = 5 * 60 * 1000;

/** A freshly minted token: the raw value (shown once) plus its stored summary. */
export type CreatedApiToken = {
	token: string;
	summary: ApiTokenSummary;
};

export type ApiTokenAuth = {
	user: User;
	tokenId: string;
	scopes: ApiScope[];
};

function tokenPrefix(token: string): string | null {
	for (const prefix of TOKEN_PREFIXES) {
		if (token.startsWith(prefix)) return prefix;
	}
	return null;
}

function isPlausibleApiToken(token: string): boolean {
	const prefix = tokenPrefix(token);
	return Boolean(prefix && token.length > prefix.length && token.length <= MAX_TOKEN_LENGTH);
}

export function isValidScope(scopes: unknown): scopes is ApiScope[] {
	return parseScopes(scopes, true) !== null;
}

/** Deduped, known scopes. `admin` is rejected unless the owner is an admin. */
export function parseScopes(input: unknown, allowAdmin: boolean): ApiScope[] | null {
	if (!Array.isArray(input) || input.length === 0) return null;

	const scopes: ApiScope[] = [];
	for (const item of input) {
		if (!isApiScope(item)) return null;
		if (item === 'admin' && !allowAdmin) return null;
		if (!scopes.includes(item)) scopes.push(item);
	}

	return scopes;
}

function toBase64Url(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) binary += String.fromCodePoint(byte);
	return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

/** `qi_live_<32 random bytes, base64url>` — recognizable and collision-resistant. */
function generateToken(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	return `${TOKEN_PREFIX}${toBase64Url(bytes)}`;
}

/** Preview the random part, not the shared `qi_live_` / `qm_live_` prefix. */
export function previewFor(token: string): string {
	const prefix = tokenPrefix(token);
	const random = prefix ? token.slice(prefix.length) : token;
	if (random.length < 8) return random;
	return `${random.slice(0, 4)}…${random.slice(-4)}`;
}

/** Read a `Bearer <token>` value off the Authorization header, if present. */
export function readBearerToken(request: Request): string | null {
	const header = request.headers.get('authorization');
	if (!header) return null;
	const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
	if (!match) return null;
	const token = match[1];
	if (token.length > MAX_TOKEN_LENGTH) return null;
	return token;
}

export type ApiTokenService = {
	createApiToken(
		userId: string,
		options?: { name?: string; scopes?: ApiScope[] }
	): Promise<CreatedApiToken>;
	listApiTokens(userId: string): Promise<ApiTokenSummary[]>;
	revokeApiToken(userId: string, tokenId: string): Promise<boolean>;
	/** Resolves a bearer token to its owning user. Null when unknown, revoked, or not yet usable. */
	getUserByApiToken(token: string): Promise<ApiTokenAuth | null>;
};

export function createApiTokenService(repo: ApiTokenRepository): ApiTokenService {
	return {
		async createApiToken(userId, options = {}) {
			const token = generateToken();
			const hash = await hashToken(token);
			const id = crypto.randomUUID();
			const scopes: ApiScope[] = options.scopes?.length ? options.scopes : ['mail:send'];
			const name = (options.name ?? '').trim().slice(0, 60) || 'Default';
			const createdAt = new Date().toISOString();
			const preview = previewFor(token);

			await repo.insertToken({
				id,
				userId,
				name,
				tokenHash: hash,
				tokenPreview: preview,
				scopes,
				createdAt
			});

			return {
				token,
				summary: {
					id,
					name,
					preview,
					scopes,
					created_at: createdAt,
					last_used_at: null
				}
			};
		},

		listApiTokens: (userId) => repo.listByUser(userId),
		revokeApiToken: (userId, tokenId) => repo.revoke(userId, tokenId),

		async getUserByApiToken(token) {
			if (!isPlausibleApiToken(token)) return null;

			const hash = await hashToken(token);
			const found = await repo.findAuthByTokenHash(hash);
			if (!found) return null;
			// An account still on its temporary password has no API access yet.
			if (found.user.must_change_password) return null;

			const lastUsed = found.lastUsedAt ? Date.parse(found.lastUsedAt) : 0;
			if (!lastUsed || Date.now() - lastUsed >= LAST_USED_THROTTLE_MS) {
				await repo.touchLastUsed(found.tokenId, new Date().toISOString());
			}

			return { user: found.user, tokenId: found.tokenId, scopes: found.scopes };
		}
	};
}
