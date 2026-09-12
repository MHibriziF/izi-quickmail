import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { D1Database } from '@cloudflare/workers-types';
import { resolveThreadId } from '../threads';

/** Every lookup carries the domain predicate and only matches inside it. */
function matchingDb(expectedDomain: string, match: { id: string; thread_id: string }) {
	return {
		prepare(sql: string) {
			return {
				bind(...values: unknown[]) {
					return {
						async first() {
							assert.match(sql, /AND domain_id = \?/);
							return values.includes(expectedDomain) ? match : null;
						}
					};
				}
			};
		}
	} as unknown as D1Database;
}

describe('domain-scoped threading', () => {
	test('does not merge the same subject and participant across domains', async () => {
		const emailId = 'second-domain-message';
		const threadId = await resolveThreadId(
			matchingDb('example.com', { id: 'first-message', thread_id: 'first-thread' }),
			'user-1',
			{
				emailId,
				direction: 'inbound',
				subject: 'Inbox test',
				from: 'sender@external.test',
				to: 'support@example.org',
				domainId: 'example.org',
				replyToEmailId: 'first-message',
				inReplyTo: 'first-message-id'
			}
		);

		assert.equal(threadId, emailId);
	});

	test('still merges matching messages inside the same domain', async () => {
		const threadId = await resolveThreadId(
			matchingDb('example.org', { id: 'earlier-message', thread_id: 'earlier-thread' }),
			'user-1',
			{
				emailId: 'new-reply',
				direction: 'inbound',
				subject: 'Re: Inbox test',
				from: 'sender@external.test',
				to: 'support@example.org',
				domainId: 'example.org'
			}
		);

		assert.equal(threadId, 'earlier-thread');
	});
});

describe('subject fallback', () => {
	test('does not merge a forward through the sender mailbox when disabled', async () => {
		let subjectLookupRan = false;
		const db = {
			prepare(sql: string) {
				subjectLookupRan = subjectLookupRan || sql.includes('AND thread_key = ?');
				return {
					bind() {
						return {
							async first() {
								return {
									id: 'alice-message',
									thread_id: 'alice-thread'
								};
							}
						};
					}
				};
			}
		} as unknown as D1Database;

		const threadId = await resolveThreadId(db, 'user-1', {
			emailId: 'forward-to-bob',
			direction: 'outbound',
			subject: 'Fwd: Quarterly figures',
			from: 'me@example.com',
			to: 'bob@example.com',
			domainId: 'example.com',
			subjectMatch: false
		});

		assert.equal(threadId, 'forward-to-bob');
		assert.equal(subjectLookupRan, false);
	});

	test('matches a reply to a forward through the external sender', async () => {
		const db = {
			prepare(sql: string) {
				return {
					bind(...values: unknown[]) {
						return {
							async first() {
								if (!sql.includes('AND thread_key = ?')) return null;
								assert.equal(values.at(-1), 'bob@example.com');
								assert.equal(values.includes('me@example.com'), false);
								return {
									id: 'forward-to-bob',
									thread_id: 'forward-to-bob'
								};
							}
						};
					}
				};
			}
		} as unknown as D1Database;

		const threadId = await resolveThreadId(db, 'user-1', {
			emailId: 'reply-from-bob',
			direction: 'inbound',
			subject: 'Re: Fwd: Quarterly figures',
			from: 'bob@example.com',
			to: 'me@example.com',
			domainId: 'example.com'
		});

		assert.equal(threadId, 'forward-to-bob');
	});

	test('does not match a reply to a forward through the user mailbox', async () => {
		const db = {
			prepare(sql: string) {
				return {
					bind(...values: unknown[]) {
						return {
							async first() {
								if (!sql.includes('AND thread_key = ?')) return null;
								assert.equal(values.at(-1), 'bob@example.com');
								assert.equal(values.includes('me@example.com'), false);
								return null;
							}
						};
					}
				};
			}
		} as unknown as D1Database;

		const threadId = await resolveThreadId(db, 'user-1', {
			emailId: 'reply-from-bob',
			direction: 'inbound',
			subject: 'Re: Fwd: Quarterly figures',
			from: 'bob@example.com',
			to: 'me@example.com',
			domainId: 'example.com'
		});

		assert.equal(threadId, 'reply-from-bob');
	});
});


/**
 * A stand-in for the subject-fallback lookup specifically (the reply and
 * message-id lookups are skipped in these tests by leaving replyToEmailId /
 * inReplyTo / references unset). Filters candidates the same way the real
 * query does, from the same bound values the real code produces — including
 * the `direction <> ?` guard — so a regression in that predicate fails this
 * test rather than only a hand-simulated one.
 */
type FallbackRow = {
	id: string;
	thread_id: string;
	thread_key: string;
	direction: 'inbound' | 'outbound';
	from_addr: string;
	to_addr: string;
	cc_addr?: string | null;
	domain_id?: string | null;
	status?: string | null;
	created_at: string;
};

function subjectFallbackDb(rows: FallbackRow[]) {
	return {
		prepare(sql: string) {
			return {
				bind(...values: unknown[]) {
					return {
						async first() {
							if (!sql.includes('AND thread_key = ?')) return null;
							assert.match(sql, /AND direction <> \?/);

							const hasDomainClause = sql.includes('AND domain_id = ?');
							const threadKey = values[1] as string;
							let i = 2;
							const domainId = hasDomainClause ? (values[i++] as string) : undefined;
							i += 1; // the "-N day" window; every fixture row here counts as recent
							const direction = values[i++] as 'inbound' | 'outbound';
							const participants = (values.slice(i) as string[]).map((value) => value.toLowerCase());

							const candidates = rows
								.filter((row) => row.thread_key === threadKey)
								.filter((row) => (row.status ?? null) !== 'draft')
								.filter((row) => !hasDomainClause || row.domain_id === domainId)
								.filter((row) => row.direction !== direction)
								.filter((row) => {
									const haystack = `${row.from_addr} ${row.to_addr} ${row.cc_addr ?? ''}`.toLowerCase();
									return participants.some((participant) => haystack.includes(participant));
								})
								.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));

							const [top] = candidates;
							return top ? { thread_id: top.thread_id, id: top.id } : null;
						}
					};
				}
			};
		}
	} as unknown as D1Database;
}

describe('subject fallback requires an actual reply', () => {
	test('two inbound notices from the same sender and subject stay separate', async () => {
		// noreply@ senders that reuse one subject for unrelated notices were
		// merging into a single conversation, so marking one read marked every
		// other notice read with it.
		const db = subjectFallbackDb([
			{
				id: 'notice-1',
				thread_id: 'notice-1',
				thread_key: 'account notice',
				direction: 'inbound',
				from_addr: 'noreply@sifpi.my.id',
				to_addr: 'ada@example.com',
				created_at: '2026-09-01'
			}
		]);

		const threadId = await resolveThreadId(db, 'user-1', {
			emailId: 'notice-2',
			direction: 'inbound',
			subject: 'Account notice',
			from: 'noreply@sifpi.my.id',
			to: 'ada@example.com'
		});

		assert.equal(threadId, 'notice-2');
	});

	test('an inbound reply still finds the outbound message it answers', async () => {
		const db = subjectFallbackDb([
			{
				id: 'sent-1',
				thread_id: 'sent-1',
				thread_key: 'project x',
				direction: 'outbound',
				from_addr: 'ada@example.com',
				to_addr: 'bob@example.com',
				created_at: '2026-09-01'
			}
		]);

		const threadId = await resolveThreadId(db, 'user-1', {
			emailId: 'bob-reply',
			direction: 'inbound',
			subject: 'Re: Project X',
			from: 'bob@example.com',
			to: 'ada@example.com'
		});

		assert.equal(threadId, 'sent-1');
	});

	test('an outbound reply still finds the inbound message it answers', async () => {
		const db = subjectFallbackDb([
			{
				id: 'their-msg',
				thread_id: 'their-msg',
				thread_key: 'project x',
				direction: 'inbound',
				from_addr: 'bob@example.com',
				to_addr: 'ada@example.com',
				created_at: '2026-09-01'
			}
		]);

		const threadId = await resolveThreadId(db, 'user-1', {
			emailId: 'ada-reply',
			direction: 'outbound',
			subject: 'Re: Project X',
			from: 'ada@example.com',
			to: 'bob@example.com'
		});

		assert.equal(threadId, 'their-msg');
	});

	test('two outbound messages to the same address and subject stay separate', async () => {
		// The user sending two unrelated messages to the same person with the
		// same subject (e.g. a recurring "Invoice" they send out) is the
		// outbound mirror of the noreply@ case — neither is a reply to the other.
		const db = subjectFallbackDb([
			{
				id: 'invoice-1',
				thread_id: 'invoice-1',
				thread_key: 'invoice',
				direction: 'outbound',
				from_addr: 'ada@example.com',
				to_addr: 'bob@example.com',
				created_at: '2026-09-01'
			}
		]);

		const threadId = await resolveThreadId(db, 'user-1', {
			emailId: 'invoice-2',
			direction: 'outbound',
			subject: 'Invoice',
			from: 'ada@example.com',
			to: 'bob@example.com'
		});

		assert.equal(threadId, 'invoice-2');
	});
});
