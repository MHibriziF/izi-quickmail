import type { D1Database } from '@cloudflare/workers-types';

export type AdmissionStatus = 'pending' | 'admitted' | 'denied';

export type PendingAdmission = {
	id: string;
	name: string;
	created_at: string;
};

/**
 * A guest's request to join a meeting that requires the host to let people in. Ownership of the
 * parent meeting is checked by the caller (route), not here — these rows aren't owner-scoped
 * themselves, the meeting they belong to is.
 */
export async function createAdmission(db: D1Database, meetingId: string, name: string): Promise<{ id: string }> {
	const id = crypto.randomUUID();
	await db
		.prepare('INSERT INTO meeting_admissions (id, meeting_id, name) VALUES (?, ?, ?)')
		.bind(id, meetingId, name.trim().slice(0, 100) || 'Guest')
		.run();

	return { id };
}

export async function getAdmission(
	db: D1Database,
	meetingId: string,
	admissionId: string
): Promise<{ status: AdmissionStatus } | null> {
	const row = await db
		.prepare('SELECT status FROM meeting_admissions WHERE id = ? AND meeting_id = ?')
		.bind(admissionId, meetingId)
		.first<{ status: AdmissionStatus }>();

	return row ?? null;
}

export async function listPendingAdmissions(db: D1Database, meetingId: string): Promise<PendingAdmission[]> {
	const { results } = await db
		.prepare(
			`SELECT id, name, created_at FROM meeting_admissions
			 WHERE meeting_id = ? AND status = 'pending'
			 ORDER BY created_at ASC`
		)
		.bind(meetingId)
		.all<PendingAdmission>();

	return results;
}

export async function setAdmissionStatus(
	db: D1Database,
	meetingId: string,
	admissionId: string,
	status: Exclude<AdmissionStatus, 'pending'>
): Promise<boolean> {
	const result = await db
		.prepare(`UPDATE meeting_admissions SET status = ? WHERE id = ? AND meeting_id = ?`)
		.bind(status, admissionId, meetingId)
		.run();

	return (result.meta.changes ?? 0) > 0;
}
