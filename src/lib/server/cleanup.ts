import type { D1Database, R2Bucket } from '@cloudflare/workers-types';
import { deleteEmailsPermanently } from './mail-store';
import { SWEEP_AGE_CHOICES, TRASH_RETENTION_CHOICES } from '$lib/cleanup-options';

export { TRASH_RETENTION_CHOICES, SWEEP_AGE_CHOICES } from '$lib/cleanup-options';
/** One sweep cannot run away with the whole mailbox in a single request. */
const SWEEP_BATCH_LIMIT = 500;

export type SweepFilter = {
	olderThanDays: number;
	/** Leave anything still unread — the usual reason to keep an old message. */
	onlyRead: boolean;
	keepStarred: boolean;
};

/**
 * Builds the shared WHERE for a sweep.
 *
 * Drafts and scheduled messages are never swept: neither has been sent, and
 * losing one to a date filter would destroy unsent writing.
 */
function sweepWhere(filter: SweepFilter): { sql: string; bindings: unknown[] } {
	const clauses = [
		'user_id = ?',
		'deleted_at IS NULL',
		"(status IS NULL OR status NOT IN ('draft', 'scheduled'))",
		"created_at < datetime('now', ?)"
	];
	const bindings: unknown[] = [`-${Math.max(1, Math.floor(filter.olderThanDays))} days`];

	if (filter.onlyRead) clauses.push('is_read = 1');
	if (filter.keepStarred) clauses.push('is_starred = 0');

	return { sql: clauses.join(' AND '), bindings };
}

/** How many messages a sweep would move. Shown before anything is touched. */
export async function countSweepCandidates(
	db: D1Database,
	userId: string,
	filter: SweepFilter
): Promise<number> {
	const { sql, bindings } = sweepWhere(filter);
	const row = await db
		.prepare(`SELECT COUNT(*) AS count FROM emails WHERE ${sql}`)
		.bind(userId, ...bindings)
		.first<{ count: number }>();

	return row?.count ?? 0;
}

/**
 * Moves old mail to the trash rather than deleting it.
 *
 * A date filter is a blunt instrument, so the result stays recoverable; the
 * retention setting is what eventually makes it permanent.
 */
export async function sweepOldMail(
	db: D1Database,
	userId: string,
	filter: SweepFilter
): Promise<number> {
	const { sql, bindings } = sweepWhere(filter);
	const result = await db
		.prepare(
			`UPDATE emails SET deleted_at = datetime('now')
			  WHERE id IN (SELECT id FROM emails WHERE ${sql} LIMIT ${SWEEP_BATCH_LIMIT})`
		)
		.bind(userId, ...bindings)
		.run();

	return result.meta.changes ?? 0;
}

/** Permanently removes trash deleted longer ago than `days`, attachments too. */
export async function purgeExpiredTrash(
	db: D1Database,
	bucket: R2Bucket | undefined,
	userId: string,
	days: number
): Promise<number> {
	if (days <= 0) return 0;

	const { results } = await db
		.prepare(
			`SELECT id FROM emails
			  WHERE user_id = ? AND deleted_at IS NOT NULL
			    AND deleted_at < datetime('now', ?)
			  LIMIT ${SWEEP_BATCH_LIMIT}`
		)
		.bind(userId, `-${Math.floor(days)} days`)
		.all<{ id: string }>();

	if (results.length === 0) return 0;

	return deleteEmailsPermanently(
		db,
		bucket,
		userId,
		results.map((row) => row.id)
	);
}

export type CleanupSettings = { trashRetentionDays: number };

export async function getCleanupSettings(
	db: D1Database,
	userId: string
): Promise<CleanupSettings> {
	const row = await db
		.prepare('SELECT trash_retention_days FROM users WHERE id = ?')
		.bind(userId)
		.first<{ trash_retention_days: number }>();

	return { trashRetentionDays: row?.trash_retention_days ?? 0 };
}

export async function setTrashRetention(
	db: D1Database,
	userId: string,
	days: number
): Promise<void> {
	if (!TRASH_RETENTION_CHOICES.includes(days as (typeof TRASH_RETENTION_CHOICES)[number])) {
		throw new Error('Pick one of the offered retention periods');
	}

	await db
		.prepare('UPDATE users SET trash_retention_days = ? WHERE id = ?')
		.bind(days, userId)
		.run();
}

/**
 * Runs the automatic purge, at most once a day.
 *
 * The claim and the throttle are the same UPDATE, so two requests arriving
 * together cannot both decide it is their turn. Returns how many were removed.
 */
export async function runDueTrashPurge(
	db: D1Database,
	bucket: R2Bucket | undefined,
	userId: string
): Promise<number> {
	const claim = await db
		.prepare(
			`UPDATE users SET last_trash_purge_at = datetime('now')
			  WHERE id = ? AND trash_retention_days > 0
			    AND (last_trash_purge_at IS NULL
			         OR last_trash_purge_at < datetime('now', '-1 day'))`
		)
		.bind(userId)
		.run();

	if ((claim.meta.changes ?? 0) !== 1) return 0;

	const { trashRetentionDays } = await getCleanupSettings(db, userId);
	return purgeExpiredTrash(db, bucket, userId, trashRetentionDays);
}
