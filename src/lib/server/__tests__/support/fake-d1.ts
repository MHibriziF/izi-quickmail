import type { D1Database } from '@cloudflare/workers-types';

type Query = { sql: string; args: unknown[] };

/**
 * Minimal in-memory stand-in for D1's `prepare().bind().first()/all()/run()`
 * chain, sharing just the plumbing every repository test needs — the
 * SQL-to-rows logic is still supplied per test via `execute`, since that part
 * is genuinely repository-specific. Extracted so repository tests stop
 * reimplementing this same nested-closure shape from scratch.
 */
export function createFakeD1(execute: (query: Query) => unknown[]): D1Database {
	function statement(sql: string, args: unknown[]) {
		return {
			bind: (...nextArgs: unknown[]) => statement(sql, nextArgs),
			first: async <T>() => ((execute({ sql, args }) as T[])[0] ?? null),
			all: async <T>() => ({ results: execute({ sql, args }) as T[] }),
			raw: async <T>() => execute({ sql, args }) as T[],
			run: async () => {
				execute({ sql, args });
				return { success: true, meta: {} } as unknown;
			}
		};
	}

	return {
		prepare: (sql: string) => statement(sql, []),
		batch: async (statements: Array<{ run: () => Promise<unknown> }>) => {
			const results = [];
			for (const stmt of statements) results.push(await stmt.run());
			return results;
		}
	} as unknown as D1Database;
}
