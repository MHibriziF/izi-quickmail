import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createFakeD1 } from '../../__tests__/support/fake-d1';
import { createD1ApiTokenRepository } from '../repository';

type UserRow = {
	id: string;
	email: string;
	name: string;
	is_admin: number;
	must_change_password: number;
	created_at: string;
};

type TokenRow = {
	id: string;
	user_id: string;
	name: string;
	token_hash: string;
	token_preview: string;
	scopes: string;
	created_at: string;
	last_used_at: string | null;
};

function makeRepo() {
	const users = new Map<string, UserRow>();
	const tokens = new Map<string, TokenRow>();

	users.set('u1', {
		id: 'u1',
		email: 'ada@example.com',
		name: 'Ada',
		is_admin: 0,
		must_change_password: 0,
		created_at: '2024-01-01T00:00:00.000Z'
	});

	const db = createFakeD1(({ sql, args }) => {
		if (sql.startsWith('INSERT INTO api_tokens')) {
			const [id, userId, name, tokenHash, tokenPreview, scopes, createdAt] = args as string[];
			tokens.set(id, {
				id,
				user_id: userId,
				name,
				token_hash: tokenHash,
				token_preview: tokenPreview,
				scopes,
				created_at: createdAt,
				last_used_at: null
			});
			return [];
		}

		if (sql.startsWith('SELECT id, name, token_preview')) {
			const [userId] = args as string[];
			return [...tokens.values()]
				.filter((row) => row.user_id === userId)
				.sort((a, b) => b.created_at.localeCompare(a.created_at));
		}

		if (sql.startsWith('DELETE FROM api_tokens')) {
			const [tokenId, userId] = args as string[];
			const row = tokens.get(tokenId);
			if (row && row.user_id === userId) {
				tokens.delete(tokenId);
				return [row];
			}
			return [];
		}

		if (sql.includes('FROM api_tokens t') && sql.includes('JOIN users u')) {
			const [tokenHash] = args as string[];
			const row = [...tokens.values()].find((t) => t.token_hash === tokenHash);
			if (!row) return [];
			const user = users.get(row.user_id);
			if (!user) return [];
			return [
				{
					id: user.id,
					email: user.email,
					name: user.name,
					is_admin: user.is_admin,
					must_change_password: user.must_change_password,
					created_at: user.created_at,
					token_id: row.id,
					scopes: row.scopes,
					last_used_at: row.last_used_at
				}
			];
		}

		if (sql.startsWith('UPDATE api_tokens SET last_used_at')) {
			const [at, tokenId] = args as string[];
			const row = tokens.get(tokenId);
			if (row) row.last_used_at = at;
			return row ? [row] : [];
		}

		throw new Error(`Unhandled query in fake D1: ${sql}`);
	});

	return { repo: createD1ApiTokenRepository(db), tokens, users };
}

describe('ApiTokenRepository', () => {
	test('insertToken then listByUser round-trips, newest first', async () => {
		const { repo } = makeRepo();

		await repo.insertToken({
			id: 't1',
			userId: 'u1',
			name: 'First',
			tokenHash: 'hash1',
			tokenPreview: 'abcd…wxyz',
			scopes: ['mail:send'],
			createdAt: '2024-01-01T00:00:00.000Z'
		});
		await repo.insertToken({
			id: 't2',
			userId: 'u1',
			name: 'Second',
			tokenHash: 'hash2',
			tokenPreview: 'efgh…uvwx',
			scopes: ['mail:read', 'admin'],
			createdAt: '2024-02-01T00:00:00.000Z'
		});

		const list = await repo.listByUser('u1');
		assert.equal(list.length, 2);
		assert.equal(list[0].id, 't2');
		assert.deepEqual(list[0].scopes, ['mail:read', 'admin']);
		assert.equal(list[1].id, 't1');
	});

	test('listByUser filters out unknown scope strings', async () => {
		const { repo, tokens } = makeRepo();
		tokens.set('t1', {
			id: 't1',
			user_id: 'u1',
			name: 'Stale',
			token_hash: 'hash1',
			token_preview: 'abcd…wxyz',
			scopes: 'mail:send,not-a-real-scope',
			created_at: '2024-01-01T00:00:00.000Z',
			last_used_at: null
		});

		const [summary] = await repo.listByUser('u1');
		assert.deepEqual(summary.scopes, ['mail:send']);
	});

	test('revoke deletes only when the token belongs to that user', async () => {
		const { repo } = makeRepo();
		await repo.insertToken({
			id: 't1',
			userId: 'u1',
			name: 'First',
			tokenHash: 'hash1',
			tokenPreview: 'abcd…wxyz',
			scopes: ['mail:send'],
			createdAt: '2024-01-01T00:00:00.000Z'
		});

		assert.equal(await repo.revoke('someone-else', 't1'), false);
		assert.equal(await repo.revoke('u1', 't1'), true);
		assert.equal((await repo.listByUser('u1')).length, 0);
	});

	test('findAuthByTokenHash returns null for an unknown hash', async () => {
		const { repo } = makeRepo();
		assert.equal(await repo.findAuthByTokenHash('nope'), null);
	});

	test('findAuthByTokenHash joins the owning user and maps booleans', async () => {
		const { repo } = makeRepo();
		await repo.insertToken({
			id: 't1',
			userId: 'u1',
			name: 'First',
			tokenHash: 'hash1',
			tokenPreview: 'abcd…wxyz',
			scopes: ['mail:send', 'mail:read'],
			createdAt: '2024-01-01T00:00:00.000Z'
		});

		const found = await repo.findAuthByTokenHash('hash1');
		assert.equal(found?.user.email, 'ada@example.com');
		assert.equal(found?.user.is_admin, false);
		assert.equal(found?.user.must_change_password, false);
		assert.equal(found?.tokenId, 't1');
		assert.deepEqual(found?.scopes, ['mail:send', 'mail:read']);
		assert.equal(found?.lastUsedAt, null);
	});

	test('touchLastUsed stamps the token', async () => {
		const { repo } = makeRepo();
		await repo.insertToken({
			id: 't1',
			userId: 'u1',
			name: 'First',
			tokenHash: 'hash1',
			tokenPreview: 'abcd…wxyz',
			scopes: ['mail:send'],
			createdAt: '2024-01-01T00:00:00.000Z'
		});

		await repo.touchLastUsed('t1', '2024-03-01T00:00:00.000Z');

		const found = await repo.findAuthByTokenHash('hash1');
		assert.equal(found?.lastUsedAt, '2024-03-01T00:00:00.000Z');
	});
});
