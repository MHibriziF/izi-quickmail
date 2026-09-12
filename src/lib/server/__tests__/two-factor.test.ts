import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { D1Database } from '@cloudflare/workers-types';
import { hashToken } from '../crypto';
import { normalizeBackupCode, verifyChallenge } from '../two-factor';

describe('normalising a backup code', () => {
	test('accepts the shape it was shown in', () => {
		assert.equal(normalizeBackupCode('ABCD-EFGH'), 'ABCDEFGH');
	});

	test('forgives the ways someone might retype it', () => {
		// Typed in lower case, with spaces instead of the dash, or pasted with
		// stray whitespace — all the same code.
		assert.equal(normalizeBackupCode('abcd-efgh'), 'ABCDEFGH');
		assert.equal(normalizeBackupCode('abcd efgh'), 'ABCDEFGH');
		assert.equal(normalizeBackupCode('  ABCD - EFGH  '), 'ABCDEFGH');
		assert.equal(normalizeBackupCode('ABCDEFGH'), 'ABCDEFGH');
	});
});

type BackupRow = { id: string; code_hash: string; used_at: string | null };

/**
 * Enough of D1 to exercise the challenge.
 *
 * The point is the spend: `UPDATE … WHERE used_at IS NULL` reporting zero
 * changes is the only thing stopping two logins from redeeming one code.
 */
function mockDb(options: { enabled: boolean; codes: BackupRow[] }) {
	const codes = options.codes.map((row) => ({ ...row }));

	const db = {
		prepare(sql: string) {
			return {
				bind(...args: unknown[]) {
					return {
						async first() {
							if (sql.includes('totp_secret')) {
								return options.enabled
									? { totp_secret: 'JBSWY3DPEHPK3PXP', totp_enabled: 1 }
									: { totp_secret: 'JBSWY3DPEHPK3PXP', totp_enabled: 0 };
							}
							if (sql.includes('FROM totp_backup_codes')) {
								const hash = String(args[1]);
								return codes.find((row) => row.code_hash === hash && row.used_at === null) ?? null;
							}
							return null;
						},
						async run() {
							if (sql.includes('SET used_at')) {
								const row = codes.find((entry) => entry.id === String(args[0]));
								if (!row) return { meta: { changes: 0 } };
								// Only the SQL's own `used_at IS NULL` may narrow this. If the
								// statement drops that condition, the row updates twice and the
								// single-use test fails — which is the point of the test.
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

	return { db, codes };
}

describe('answering a two-factor challenge with a backup code', () => {
	// Not a valid TOTP for the secret, so the challenge falls through to the
	// backup-code path — which is what these tests are about.
	const CODE = 'ABCD-EFGH';

	async function withCode(enabled = true) {
		return mockDb({
			enabled,
			codes: [{ id: 'code-1', code_hash: await hashToken(normalizeBackupCode(CODE)), used_at: null }]
		});
	}

	test('a valid unused code is accepted', async () => {
		const { db } = await withCode();
		assert.equal(await verifyChallenge(db, 'user-1', CODE), true);
	});

	test('the same code cannot be spent twice', async () => {
		const { db, codes } = await withCode();

		assert.equal(await verifyChallenge(db, 'user-1', CODE), true);
		assert.equal(codes[0].used_at !== null, true);
		assert.equal(await verifyChallenge(db, 'user-1', CODE), false);
	});

	test('a code typed in lower case still works', async () => {
		const { db } = await withCode();
		assert.equal(await verifyChallenge(db, 'user-1', 'abcd efgh'), true);
	});

	test('an unknown code is refused', async () => {
		const { db } = await withCode();
		assert.equal(await verifyChallenge(db, 'user-1', 'ZZZZ-ZZZZ'), false);
	});

	test('nothing is accepted while two-factor is off', async () => {
		const { db } = await withCode(false);
		assert.equal(await verifyChallenge(db, 'user-1', CODE), false);
	});

	test('two logins racing for one code: only one wins', async () => {
		// Both requests read the code before either marks it spent — the case the
		// SELECT cannot catch, and the reason the UPDATE carries `used_at IS NULL`.
		const spent: string[] = [];
		const hash = await hashToken(normalizeBackupCode(CODE));
		let used = false;

		const racing = {
			prepare(sql: string) {
				return {
					bind(...args: unknown[]) {
						return {
							async first() {
								if (sql.includes('totp_secret')) {
									return { totp_secret: 'JBSWY3DPEHPK3PXP', totp_enabled: 1 };
								}
								// Deliberately ignores used_at: both racers see it as available.
								return String(args[1]) === hash ? { id: 'code-1' } : null;
							},
							async run() {
								if (!sql.includes('used_at IS NULL')) {
									spent.push('unguarded');
									return { meta: { changes: 1 } };
								}
								if (used) return { meta: { changes: 0 } };
								used = true;
								spent.push('guarded');
								return { meta: { changes: 1 } };
							}
						};
					}
				};
			}
		} as unknown as D1Database;

		const results = await Promise.all([
			verifyChallenge(racing, 'user-1', CODE),
			verifyChallenge(racing, 'user-1', CODE)
		]);

		assert.equal(results.filter(Boolean).length, 1, 'exactly one login may spend the code');
	});
});
