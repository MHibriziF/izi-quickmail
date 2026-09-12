import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { D1Database } from '@cloudflare/workers-types';
import { consumeToken, isLikelyEmail } from '../account-recovery';
import { hashToken } from '../crypto';

describe('recognising an address', () => {
	test('accepts ordinary addresses', () => {
		assert.equal(isLikelyEmail('ada@example.com'), true);
		assert.equal(isLikelyEmail('  ada.lovelace+mail@sub.example.co.uk  '), true);
	});

	test('rejects what could not be delivered to', () => {
		assert.equal(isLikelyEmail(''), false);
		assert.equal(isLikelyEmail('ada'), false);
		assert.equal(isLikelyEmail('ada@localhost'), false);
		assert.equal(isLikelyEmail('ada @example.com'), false);
		assert.equal(isLikelyEmail('a@b@example.com'), false);
	});
});

type TokenRow = {
	id: string;
	user_id: string;
	kind: string;
	token_hash: string;
	used_at: string | null;
	expires_at: string;
};

/**
 * Enough of D1 to exercise redemption.
 *
 * A reset link lands in a mailbox and can be clicked twice, prefetched by a
 * scanner, or shared — so the guarantee under test is that only the first
 * redemption returns a user.
 */
function mockDb(rows: TokenRow[]) {
	const tokens = rows.map((row) => ({ ...row }));

	const db = {
		prepare(sql: string) {
			return {
				bind(...args: unknown[]) {
					return {
						async first() {
							const [kind, hash, now] = args as [string, string, string];
							return (
								tokens.find(
									(row) =>
										row.kind === kind &&
										row.token_hash === hash &&
										row.used_at === null &&
										row.expires_at > now
								) ?? null
							);
						},
						async run() {
							if (sql.includes('SET used_at')) {
								const row = tokens.find((entry) => entry.id === String(args[0]));
								if (!row) return { meta: { changes: 0 } };
								// Only the SQL's own `used_at IS NULL` may narrow this, so a
								// statement that loses the condition fails the single-use test.
								if (sql.includes('used_at IS NULL') && row.used_at !== null) {
									return { meta: { changes: 0 } };
								}
								row.used_at = '2026-09-08T00:00:00.000Z';
								return { meta: { changes: 1 } };
							}
							return { meta: { changes: 0 } };
						}
					};
				}
			};
		}
	} as unknown as D1Database;

	return { db, tokens };
}

const FUTURE = '2099-01-01T00:00:00.000Z';
const PAST = '2020-01-01T00:00:00.000Z';

async function tokenRow(overrides: Partial<TokenRow> = {}): Promise<TokenRow> {
	return {
		id: 'token-1',
		user_id: 'user-1',
		kind: 'password_reset',
		token_hash: await hashToken('the-secret-token'),
		used_at: null,
		expires_at: FUTURE,
		...overrides
	};
}

describe('redeeming a recovery token', () => {
	test('a valid token returns whose it is', async () => {
		const { db } = mockDb([await tokenRow()]);
		assert.equal(await consumeToken(db, 'password_reset', 'the-secret-token'), 'user-1');
	});

	test('a second click gets nothing', async () => {
		const { db } = mockDb([await tokenRow()]);

		assert.equal(await consumeToken(db, 'password_reset', 'the-secret-token'), 'user-1');
		assert.equal(await consumeToken(db, 'password_reset', 'the-secret-token'), null);
	});

	test('an expired token is refused', async () => {
		const { db } = mockDb([await tokenRow({ expires_at: PAST })]);
		assert.equal(await consumeToken(db, 'password_reset', 'the-secret-token'), null);
	});

	test('a token cannot be redeemed as the wrong kind', async () => {
		// A recovery-address confirmation must not double as a password reset.
		const { db } = mockDb([await tokenRow({ kind: 'recovery_email' })]);
		assert.equal(await consumeToken(db, 'password_reset', 'the-secret-token'), null);
	});

	test('an unknown token is refused', async () => {
		const { db } = mockDb([await tokenRow()]);
		assert.equal(await consumeToken(db, 'password_reset', 'not-the-token'), null);
	});

	test('the stored value is a hash, not the token', async () => {
		const row = await tokenRow();
		assert.notEqual(row.token_hash, 'the-secret-token');
		assert.equal(row.token_hash, await hashToken('the-secret-token'));
	});

	test('two clicks racing for one token: only one wins', async () => {
		// Both requests find the token before either marks it used — what the
		// SELECT alone cannot prevent, and why the UPDATE keeps `used_at IS NULL`.
		const hash = await hashToken('the-secret-token');
		let used = false;

		const racing = {
			prepare(sql: string) {
				return {
					bind(...args: unknown[]) {
						return {
							async first() {
								// Deliberately ignores used_at: both racers see it as valid.
								return String(args[1]) === hash ? { id: 'token-1', user_id: 'user-1' } : null;
							},
							async run() {
								if (!sql.includes('used_at IS NULL')) return { meta: { changes: 1 } };
								if (used) return { meta: { changes: 0 } };
								used = true;
								return { meta: { changes: 1 } };
							}
						};
					}
				};
			}
		} as unknown as D1Database;

		const results = await Promise.all([
			consumeToken(racing, 'password_reset', 'the-secret-token'),
			consumeToken(racing, 'password_reset', 'the-secret-token')
		]);

		assert.equal(results.filter(Boolean).length, 1, 'exactly one click may spend the token');
	});
});
