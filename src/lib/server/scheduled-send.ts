import type { D1Database, R2Bucket } from '@cloudflare/workers-types';
import type { EmailRow, MailAddress } from '$lib/types';
import { readOutboundAttachments } from './attachments';
import { getUserById } from './auth';
import { getAddressForUser } from './domains';
import { initialOutboundStatus, type EmailProvider } from './email-provider';
import { sendOutboundEmail } from './outbound/send-mail';

export type ScheduledSendEnv = { DB: D1Database; ATTACHMENTS: R2Bucket };

/**
 * How many messages one sweep will send.
 *
 * The trigger fires every minute, so a backlog drains quickly; the cap is what
 * keeps a single invocation inside the Workers CPU and subrequest budget.
 */
const SWEEP_BATCH_LIMIT = 25;

/**
 * Tries before a message is given up on.
 *
 * A provider that rejects the same message three times is not going to accept
 * it on the fourth, and a message that retries forever is worse than one that
 * shows the sender it failed.
 */
const MAX_SEND_ATTEMPTS = 3;

export type SweepResult = { sent: number; failed: number };

/**
 * Ids of scheduled messages whose time has come.
 *
 * `provider_id IS NULL` excludes anything left over from the old design, where
 * Resend held the message and released it itself. Migration 0019 moves those
 * on, so this is a guard rather than a live case.
 */
async function findDueEmailIds(
	db: D1Database,
	userId: string | null,
	limit: number
): Promise<string[]> {
	const scope = userId ? 'AND user_id = ?' : '';
	const bindings = userId ? [userId] : [];

	const { results } = await db
		.prepare(
			`SELECT id FROM emails
			  WHERE status = 'scheduled'
			    AND scheduled_at IS NOT NULL
			    AND scheduled_at <= ?
			    AND provider_id IS NULL
			    AND deleted_at IS NULL
			    AND send_attempts < ?
			        ${scope}
			  ORDER BY scheduled_at ASC
			  LIMIT ${Math.max(1, Math.floor(limit))}`
		)
		.bind(new Date().toISOString(), MAX_SEND_ATTEMPTS, ...bindings)
		.all<{ id: string }>();

	return results.map((row) => row.id);
}

/**
 * Takes ownership of one due message.
 *
 * The claim and the state change are the same UPDATE, so two sweeps arriving
 * together — the cron and a page load, or two ticks overlapping — cannot both
 * decide the message is theirs to send. Returns the claimed row, or null if
 * someone else got there first.
 */
async function claimDueEmail(db: D1Database, emailId: string): Promise<EmailRow | null> {
	const claim = await db
		.prepare(
			`UPDATE emails
			    SET status = 'queued', status_at = datetime('now'),
			        send_attempts = send_attempts + 1
			  WHERE id = ? AND status = 'scheduled'`
		)
		.bind(emailId)
		.run();

	if ((claim.meta.changes ?? 0) !== 1) return null;

	const row = await db
		.prepare('SELECT * FROM emails WHERE id = ?')
		.bind(emailId)
		.first<EmailRow>();

	return row ?? null;
}

/**
 * The identity a stored message goes out as.
 *
 * Replies are stored against a synthetic address id, and an address can be
 * removed between scheduling and sending, so a missing row is normal — the
 * address on the message itself is the authority either way.
 */
async function resolveStoredFrom(
	db: D1Database,
	row: EmailRow
): Promise<{ from: MailAddress; senderName: string } | null> {
	const user = await getUserById(db, row.user_id);
	if (!user) return null;

	const address = row.address_id ? await getAddressForUser(db, row.user_id, row.address_id) : null;

	return {
		from: address ?? {
			id: row.address_id ?? `scheduled:${row.from_addr}`,
			user_id: row.user_id,
			domain_id: row.domain_id ?? '',
			domain_name: row.from_addr.split('@')[1] ?? '',
			address: row.from_addr,
			label: null,
			signature: null,
			is_default: false,
			created_at: row.created_at
		},
		senderName: address?.label?.trim() || user.name
	};
}

/** Puts a message back in the queue, or gives up on it once it is out of tries. */
async function recordFailure(db: D1Database, row: EmailRow, error: unknown): Promise<void> {
	const detail = error instanceof Error ? error.message : 'Scheduled send failed';
	const exhausted = row.send_attempts >= MAX_SEND_ATTEMPTS;

	await db
		.prepare(
			`UPDATE emails
			    SET status = ?, status_at = datetime('now'), status_detail = ?
			  WHERE id = ?`
		)
		.bind(exhausted ? 'failed' : 'scheduled', detail, row.id)
		.run();
}

/**
 * Sends one message that has already been claimed.
 *
 * The stored row is the message: body, recipients and headers were fixed when
 * it was composed, and its attachments were written to R2 then, so nothing
 * here depends on the composer still being open.
 */
async function sendClaimedEmail(
	env: ScheduledSendEnv,
	provider: EmailProvider,
	row: EmailRow
): Promise<void> {
	const identity = await resolveStoredFrom(env.DB, row);
	if (!identity) {
		throw new Error('The account that scheduled this message is gone');
	}

	const attachments = await readOutboundAttachments(env.DB, env.ATTACHMENTS, row.user_id, row.id);

	const { providerId } = await sendOutboundEmail(provider, {
		from: identity.from,
		senderName: identity.senderName,
		to: row.to_addr,
		cc: row.cc_addr ?? undefined,
		bcc: row.bcc_addr ?? undefined,
		subject: row.subject,
		text: row.body_text ?? '',
		html: row.body_html ?? undefined,
		inReplyTo: row.in_reply_to,
		references: row.references_header,
		attachments,
		// The row id, so a sweep that sends but then fails to write the result
		// cannot deliver the same message twice on the next tick.
		idempotencyKey: `scheduled:${row.id}`
	});

	await env.DB.prepare(
		`UPDATE emails
		    SET status = ?, status_at = datetime('now'), status_detail = NULL,
		        provider_id = ?
		  WHERE id = ?`
	)
		.bind(initialOutboundStatus(provider.kind), providerId, row.id)
		.run();
}

/**
 * Sends every scheduled message that is due.
 *
 * Called from the Worker's cron trigger, and again on page load so that a
 * `vite dev` session — which never runs the Worker, and so never fires the
 * trigger — still delivers. Pass `userId` to limit the sweep to one mailbox,
 * which is what the page-load path does.
 */
export async function runDueScheduledSends(
	env: ScheduledSendEnv,
	provider: EmailProvider,
	options: { userId?: string | null; limit?: number } = {}
): Promise<SweepResult> {
	const due = await findDueEmailIds(
		env.DB,
		options.userId ?? null,
		options.limit ?? SWEEP_BATCH_LIMIT
	);

	let sent = 0;
	let failed = 0;

	for (const emailId of due) {
		const row = await claimDueEmail(env.DB, emailId);
		if (!row) continue;

		try {
			await sendClaimedEmail(env, provider, row);
			sent += 1;
		} catch (error) {
			// One bad message must not strand the rest of the batch.
			await recordFailure(env.DB, row, error);
			failed += 1;
		}
	}

	return { sent, failed };
}

/**
 * Takes a scheduled message back out of the queue and returns it as a draft.
 *
 * The row is only released if it is still `scheduled`, so a message the sweep
 * has already claimed stays sent mail rather than reappearing as an unsent
 * draft the sender thinks never went out.
 */
export async function cancelScheduledSend(
	db: D1Database,
	userId: string,
	emailId: string
): Promise<boolean> {
	const result = await db
		.prepare(
			`UPDATE emails
			    SET status = 'draft', scheduled_at = NULL, send_attempts = 0,
			        status_detail = NULL, status_at = datetime('now')
			  WHERE id = ? AND user_id = ? AND status = 'scheduled'`
		)
		.bind(emailId, userId)
		.run();

	return (result.meta.changes ?? 0) === 1;
}
