import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getMeetingForUser } from '$lib/server/meet/meetings';
import { listPendingAdmissions } from '$lib/server/meet/admissions';

/** Polled by the in-call "waiting to join" panel — owner-only. */
export const GET: RequestHandler = async ({ params, locals, platform }) => {
	const db = platform?.env.DB;
	if (!db || !locals.user) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	const meeting = await getMeetingForUser(db, locals.user.id, params.id);
	if (!meeting) return json({ error: 'Meeting not found' }, { status: 404 });

	return json({ admissions: await listPendingAdmissions(db, params.id) });
};
