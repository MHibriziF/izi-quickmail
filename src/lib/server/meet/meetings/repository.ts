import type { D1Database } from '@cloudflare/workers-types';

export type Meeting = {
	id: string;
	user_id: string;
	code: string | null;
	title: string | null;
	require_approval: boolean;
	created_at: string;
};

type MeetingRow = Omit<Meeting, 'require_approval'> & { require_approval: number };

function toMeeting(row: MeetingRow): Meeting {
	return { ...row, require_approval: !!row.require_approval };
}

export type NewMeeting = {
	id: string;
	userId: string;
	domainId: string | null;
	title: string;
	code: string;
	requireApproval: boolean;
	createdAt: string;
};

export type MeetingFieldPatch = { title?: string | null; requireApproval?: boolean };

/**
 * Raw D1 access for meetings — no retry-on-collision, no default-title
 * generation, no title normalization. See `../meetings/service.ts` for those
 * rules; `insert`/`updateCode` let a unique-constraint violation on `code`
 * propagate exactly as D1 throws it, for the service's retry loop to catch.
 */
export type MeetingsRepository = {
	countForUser(userId: string): Promise<number>;
	insert(meeting: NewMeeting): Promise<void>;
	listForUser(userId: string): Promise<Meeting[]>;
	findByCode(code: string): Promise<Meeting | null>;
	getForUser(userId: string, id: string): Promise<Meeting | null>;
	updateFields(userId: string, id: string, patch: MeetingFieldPatch): Promise<boolean>;
	updateCode(userId: string, id: string, code: string): Promise<boolean>;
};

const SELECT_FIELDS = 'id, user_id, code, title, require_approval, created_at';

export function createD1MeetingsRepository(db: D1Database): MeetingsRepository {
	return {
		async countForUser(userId) {
			const row = await db
				.prepare('SELECT COUNT(*) AS count FROM meetings WHERE user_id = ?')
				.bind(userId)
				.first<{ count: number }>();
			return row?.count ?? 0;
		},

		async insert(meeting) {
			await db
				.prepare(
					`INSERT INTO meetings (id, user_id, domain_id, title, code, require_approval, created_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?)`
				)
				.bind(
					meeting.id,
					meeting.userId,
					meeting.domainId,
					meeting.title,
					meeting.code,
					meeting.requireApproval ? 1 : 0,
					meeting.createdAt
				)
				.run();
		},

		async listForUser(userId) {
			const { results } = await db
				.prepare(`SELECT ${SELECT_FIELDS} FROM meetings WHERE user_id = ? ORDER BY created_at DESC`)
				.bind(userId)
				.all<MeetingRow>();
			return results.map(toMeeting);
		},

		async findByCode(code) {
			const row = await db
				.prepare(`SELECT ${SELECT_FIELDS} FROM meetings WHERE code = ?`)
				.bind(code)
				.first<MeetingRow>();
			return row ? toMeeting(row) : null;
		},

		async getForUser(userId, id) {
			const row = await db
				.prepare(`SELECT ${SELECT_FIELDS} FROM meetings WHERE id = ? AND user_id = ?`)
				.bind(id, userId)
				.first<MeetingRow>();
			return row ? toMeeting(row) : null;
		},

		async updateFields(userId, id, patch) {
			const sets: string[] = [];
			const values: unknown[] = [];

			if (patch.title !== undefined) {
				sets.push('title = ?');
				values.push(patch.title);
			}
			if (patch.requireApproval !== undefined) {
				sets.push('require_approval = ?');
				values.push(patch.requireApproval ? 1 : 0);
			}
			if (sets.length === 0) return false;

			const result = await db
				.prepare(`UPDATE meetings SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`)
				.bind(...values, id, userId)
				.run();

			return (result.meta.changes ?? 0) > 0;
		},

		async updateCode(userId, id, code) {
			const result = await db
				.prepare('UPDATE meetings SET code = ? WHERE id = ? AND user_id = ?')
				.bind(code, id, userId)
				.run();
			return (result.meta.changes ?? 0) > 0;
		}
	};
}
