import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { ApiTokenSummary, User } from '$lib/types';
import type { ApiTokenAuthRow, ApiTokenRepository } from '../repository';
import { createApiTokenService, isValidScope, parseScopes, previewFor, readBearerToken } from '../service';

function user(overrides: Partial<User> = {}): User {
	return {
		id: 'u1',
		email: 'ada@example.com',
		name: 'Ada',
		is_admin: false,
		must_change_password: false,
		created_at: '2024-01-01T00:00:00.000Z',
		...overrides
	};
}

function fakeRepo(overrides: Partial<ApiTokenRepository> = {}): ApiTokenRepository {
	return {
		insertToken: async () => {},
		listByUser: async () => [],
		revoke: async () => false,
		findAuthByTokenHash: async () => null,
		touchLastUsed: async () => {},
		...overrides
	};
}

describe('createApiToken', () => {
	test('defaults to mail:send and "Default" when unspecified', async () => {
		const insertedScopes: string[][] = [];
		const service = createApiTokenService(
			fakeRepo({
				insertToken: async (row) => {
					insertedScopes.push(row.scopes);
				}
			})
		);

		const created = await service.createApiToken('u1');
		assert.deepEqual(created.summary.scopes, ['mail:send']);
		assert.equal(created.summary.name, 'Default');
		assert.deepEqual(insertedScopes[0], ['mail:send']);
		assert.match(created.token, /^qi_live_/);
		assert.equal(created.summary.preview, previewFor(created.token));
	});

	test('trims and caps the name at 60 characters', async () => {
		const service = createApiTokenService(fakeRepo());
		const created = await service.createApiToken('u1', { name: `  ${'x'.repeat(80)}  ` });
		assert.equal(created.summary.name.length, 60);
	});

	test('keeps caller-provided scopes', async () => {
		const service = createApiTokenService(fakeRepo());
		const created = await service.createApiToken('u1', { scopes: ['mail:read', 'admin'] });
		assert.deepEqual(created.summary.scopes, ['mail:read', 'admin']);
	});
});

describe('listApiTokens / revokeApiToken', () => {
	test('pass straight through to the repository', async () => {
		const summary: ApiTokenSummary = {
			id: 't1',
			name: 'Default',
			preview: 'abcd…wxyz',
			scopes: ['mail:send'],
			created_at: '2024-01-01T00:00:00.000Z',
			last_used_at: null
		};
		const service = createApiTokenService(
			fakeRepo({
				listByUser: async (userId) => (userId === 'u1' ? [summary] : []),
				revoke: async (userId, tokenId) => userId === 'u1' && tokenId === 't1'
			})
		);

		assert.deepEqual(await service.listApiTokens('u1'), [summary]);
		assert.equal(await service.revokeApiToken('u1', 't1'), true);
		assert.equal(await service.revokeApiToken('u2', 't1'), false);
	});
});

describe('getUserByApiToken', () => {
	test('rejects a token without a recognized prefix before touching the repository', async () => {
		const service = createApiTokenService(
			fakeRepo({
				findAuthByTokenHash: async () => {
					throw new Error('must not be called');
				}
			})
		);

		assert.equal(await service.getUserByApiToken('not-a-token'), null);
	});

	test('returns null when the hash matches nothing', async () => {
		const service = createApiTokenService(fakeRepo());
		assert.equal(await service.getUserByApiToken('qi_live_abcdefghijklmnop'), null);
	});

	test('refuses an account still on its temporary password', async () => {
		const found: ApiTokenAuthRow = {
			user: user({ must_change_password: true }),
			tokenId: 't1',
			scopes: ['mail:send'],
			lastUsedAt: null
		};
		const service = createApiTokenService(fakeRepo({ findAuthByTokenHash: async () => found }));

		assert.equal(await service.getUserByApiToken('qi_live_abcdefghijklmnop'), null);
	});

	test('touches last-used when stale, and returns the auth', async () => {
		const found: ApiTokenAuthRow = {
			user: user(),
			tokenId: 't1',
			scopes: ['mail:send'],
			lastUsedAt: null
		};
		let touched = 0;
		const service = createApiTokenService(
			fakeRepo({
				findAuthByTokenHash: async () => found,
				touchLastUsed: async () => {
					touched += 1;
				}
			})
		);

		const auth = await service.getUserByApiToken('qi_live_abcdefghijklmnop');
		assert.equal(auth?.tokenId, 't1');
		assert.deepEqual(auth?.scopes, ['mail:send']);
		assert.equal(touched, 1);
	});

	test('does not touch last-used within the throttle window', async () => {
		const found: ApiTokenAuthRow = {
			user: user(),
			tokenId: 't1',
			scopes: ['mail:send'],
			lastUsedAt: new Date().toISOString()
		};
		let touched = 0;
		const service = createApiTokenService(
			fakeRepo({
				findAuthByTokenHash: async () => found,
				touchLastUsed: async () => {
					touched += 1;
				}
			})
		);

		await service.getUserByApiToken('qi_live_abcdefghijklmnop');
		assert.equal(touched, 0);
	});
});

describe('isValidScope', () => {
	test('agrees with parseScopes on admin-allowed input', () => {
		assert.equal(isValidScope(['mail:send']), true);
		assert.equal(isValidScope(['bogus']), false);
	});
});

describe('parseScopes', () => {
	test('rejects empty, unknown, and duplicate-only-once', () => {
		assert.equal(parseScopes([], false), null);
		assert.equal(parseScopes(['bogus'], false), null);
		assert.deepEqual(parseScopes(['mail:send', 'mail:send'], false), ['mail:send']);
	});

	test('rejects admin unless explicitly allowed', () => {
		assert.equal(parseScopes(['admin'], false), null);
		assert.deepEqual(parseScopes(['admin'], true), ['admin']);
	});
});

describe('previewFor', () => {
	test('strips the shared prefix so keys stay distinguishable', () => {
		assert.equal(previewFor('qi_live_abcdEFGHxxxxxxxxwXYZ'), 'abcd…wXYZ');
		assert.equal(previewFor('qm_live_abcdEFGHxxxxxxxxwXYZ'), 'abcd…wXYZ');
		assert.equal(previewFor('abcdEFGHxxxxxxxxwXYZ'), 'abcd…wXYZ');
	});
});

describe('readBearerToken', () => {
	test('extracts a Bearer value and rejects oversized tokens', () => {
		const token = 'qi_live_abcdefghijklmnopqrstuvwxyz012345';
		const request = new Request('https://mail.example.com', {
			headers: { authorization: `Bearer ${token}` }
		});
		assert.equal(readBearerToken(request), token);

		const oversized = new Request('https://mail.example.com', {
			headers: { authorization: `Bearer ${'x'.repeat(300)}` }
		});
		assert.equal(readBearerToken(oversized), null);
		assert.equal(readBearerToken(new Request('https://mail.example.com')), null);
	});
});
