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
				const affected = execute({ sql, args });
				// A mutating query's `execute` returns the rows it touched (or [] for
				// none), so callers that check `result.meta.changes` — e.g. an
				// ownership-scoped UPDATE that didn't match any row — see the same
				// signal a real D1 result would give them.
				return { success: true, meta: { changes: affected.length } } as unknown;
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
