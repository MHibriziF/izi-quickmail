import type { D1Database } from '@cloudflare/workers-types';
import type { ApiTokenSummary, User } from '$lib/types';

export const API_SCOPES = ['mail:send', 'mail:read', 'admin'] as const;
export type ApiScope = (typeof API_SCOPES)[number];

export function isApiScope(value: unknown): value is ApiScope {
	return typeof value === 'string' && (API_SCOPES as readonly string[]).includes(value);
}

type TokenRow = {
	id: string;
	name: string;
	token_preview: string;
	scopes: string;
	created_at: string;
	last_used_at: string | null;
};

type TokenUserRow = {
	id: string;
	email: string;
	name: string;
	is_admin: number;
	must_change_password: number;
	created_at: string;
	token_id: string;
	scopes: string;
	last_used_at: string | null;
};

export type ApiTokenAuthRow = {
	user: User;
	tokenId: string;
	scopes: ApiScope[];
	lastUsedAt: string | null;
};

function parseStoredScopes(value: string): ApiScope[] {
	return value
		.split(',')
		.map((scope) => scope.trim())
		.filter(isApiScope);
}

function mapRow(row: TokenRow): ApiTokenSummary {
	return {
		id: row.id,
		name: row.name,
		preview: row.token_preview,
		scopes: parseStoredScopes(row.scopes),
		created_at: row.created_at,
		last_used_at: row.last_used_at
	};
}

export type ApiTokenRepository = {
	insertToken(row: {
		id: string;
		userId: string;
		name: string;
		tokenHash: string;
		tokenPreview: string;
		scopes: ApiScope[];
		createdAt: string;
	}): Promise<void>;
	listByUser(userId: string): Promise<ApiTokenSummary[]>;
	revoke(userId: string, tokenId: string): Promise<boolean>;
	findAuthByTokenHash(tokenHash: string): Promise<ApiTokenAuthRow | null>;
	touchLastUsed(tokenId: string, at: string): Promise<void>;
};

export function createD1ApiTokenRepository(db: D1Database): ApiTokenRepository {
	return {
		async insertToken(row) {
			await db
				.prepare(
					`INSERT INTO api_tokens (id, user_id, name, token_hash, token_preview, scopes, created_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?)`
				)
				.bind(
					row.id,
					row.userId,
					row.name,
					row.tokenHash,
					row.tokenPreview,
					row.scopes.join(','),
					row.createdAt
				)
				.run();
		},

		async listByUser(userId) {
			const { results } = await db
				.prepare(
					`SELECT id, name, token_preview, scopes, created_at, last_used_at
					 FROM api_tokens WHERE user_id = ? ORDER BY created_at DESC`
				)
				.bind(userId)
				.all<TokenRow>();

			return results.map(mapRow);
		},

		async revoke(userId, tokenId) {
			const result = await db
				.prepare('DELETE FROM api_tokens WHERE id = ? AND user_id = ?')
				.bind(tokenId, userId)
				.run();

			return (result.meta.changes ?? 0) > 0;
		},

		async findAuthByTokenHash(tokenHash) {
			const row = await db
				.prepare(
					`SELECT u.id, u.email, u.name, u.is_admin, u.must_change_password, u.created_at,
					        t.id AS token_id, t.scopes, t.last_used_at
					 FROM api_tokens t
					 JOIN users u ON u.id = t.user_id
					 WHERE t.token_hash = ?`
				)
				.bind(tokenHash)
				.first<TokenUserRow>();

			if (!row) return null;

			return {
				user: {
					id: row.id,
					email: row.email,
					name: row.name,
					is_admin: row.is_admin === 1,
					must_change_password: row.must_change_password === 1,
					created_at: row.created_at
				},
				tokenId: row.token_id,
				scopes: parseStoredScopes(row.scopes),
				lastUsedAt: row.last_used_at
			};
		},

		async touchLastUsed(tokenId, at) {
			await db.prepare('UPDATE api_tokens SET last_used_at = ? WHERE id = ?').bind(at, tokenId).run();
		}
	};
}
