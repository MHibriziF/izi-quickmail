import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { D1Database } from '@cloudflare/workers-types';
import { createFakeD1 } from '../../__tests__/support/fake-d1';
import { getApiTokenService } from '../index';

function fakeDb(): D1Database {
	return createFakeD1(() => []);
}

describe('getApiTokenService', () => {
	test('throws when the database is unavailable', () => {
		assert.throws(() => getApiTokenService(undefined), /Database unavailable/);
	});

	test('builds a working service from a platform-shaped object', async () => {
		const platform = { env: { DB: fakeDb() } } as unknown as App.Platform;
		const service = getApiTokenService(platform);
		assert.deepEqual(await service.listApiTokens('u1'), []);
	});
});
