import type { D1Database } from '@cloudflare/workers-types';
import { parseEmailAddresses } from './util/email-address';

/** How far back to look. A personal mailbox never needs more than this. */
const SCAN_LIMIT = 400;

export type RecipientSuggestion = {
	address: string;
	/** How many sent messages went to it — the main ranking signal. */
	count: number;
	lastSentAt: string;
};

type SentRow = {
	to_addr: string;
	cc_addr: string | null;
	bcc_addr: string | null;
	created_at: string;
};

/**
 * Addresses this user has sent to before, most useful first.
 *
 * The recipient columns hold comma-joined lists, which SQL cannot split, so the
 * recent slice is unpacked here instead. Ranking puts prefix matches above
 * substring ones, then how often the address has been used, then recency —
 * so typing "gu" surfaces guy@… ahead of someone@…gu…
 */
export async function suggestRecipients(
	db: D1Database,
	userId: string,
	query: string,
	limit = 8
): Promise<RecipientSuggestion[]> {
	const { results } = await db
		.prepare(
			`SELECT to_addr, cc_addr, bcc_addr, created_at
			   FROM emails
			  WHERE user_id = ? AND direction = 'outbound'
			  ORDER BY created_at DESC
			  LIMIT ?`
		)
		.bind(userId, SCAN_LIMIT)
		.all<SentRow>();

	const seen = new Map<string, RecipientSuggestion>();

	for (const row of results) {
		const addresses = [
			...parseEmailAddresses(row.to_addr),
			...parseEmailAddresses(row.cc_addr),
			...parseEmailAddresses(row.bcc_addr)
		];

		for (const address of addresses) {
			const existing = seen.get(address);
			if (existing) {
				existing.count += 1;
				// Rows arrive newest-first, so the first sighting is the latest.
			} else {
				seen.set(address, { address, count: 1, lastSentAt: row.created_at });
			}
		}
	}

	const needle = query.trim().toLowerCase();
	const matches = needle
		? [...seen.values()].filter((entry) => entry.address.includes(needle))
		: [...seen.values()];

	return matches
		.sort((a, b) => {
			const aStarts = a.address.startsWith(needle) ? 0 : 1;
			const bStarts = b.address.startsWith(needle) ? 0 : 1;
			if (aStarts !== bStarts) return aStarts - bStarts;
			if (a.count !== b.count) return b.count - a.count;
			return b.lastSentAt.localeCompare(a.lastSentAt);
		})
		.slice(0, limit);
}
