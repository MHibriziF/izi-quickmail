import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getMeetingsService } from '$lib/server/meet/meetings';

type UpdateMeetingBody = {
	title?: unknown;
	requireApproval?: unknown;
};

/** Owner-only — used by the in-call host settings panel to know the meeting's current admission mode. */
export const GET: RequestHandler = async ({ params, locals, platform }) => {
	if (!platform?.env.DB || !locals.user) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	const meeting = await getMeetingsService(platform).getForUser(locals.user.id, params.id);
	if (!meeting) return json({ error: 'Meeting not found' }, { status: 404 });
	return json({ meeting });
};

/** Backs both the /meetings list's edit option and the in-call host settings panel — same check, same effect. */
export const PATCH: RequestHandler = async ({ params, request, locals, platform }) => {
	if (!platform?.env.DB || !locals.user) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	const body = (await request.json().catch(() => ({}))) as UpdateMeetingBody;
	const meeting = await getMeetingsService(platform).update(locals.user.id, params.id, {
		title: typeof body.title === 'string' ? body.title : undefined,
		requireApproval: typeof body.requireApproval === 'boolean' ? body.requireApproval : undefined
	});

	if (!meeting) return json({ error: 'Meeting not found' }, { status: 404 });
	return json({ meeting });
};
