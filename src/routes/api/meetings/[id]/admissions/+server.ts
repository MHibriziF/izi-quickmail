import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getMeetingsService } from '$lib/server/meet/meetings';

/** Polled by the in-call "waiting to join" panel — owner-only. */
export const GET: RequestHandler = async ({ params, locals, platform }) => {
	if (!platform?.env.DB || !locals.user) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	const admissions = await getMeetingsService(platform).listPendingAdmissions(locals.user.id, params.id);
	if (!admissions) return json({ error: 'Meeting not found' }, { status: 404 });

	return json({ admissions });
};
