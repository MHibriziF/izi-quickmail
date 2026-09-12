import { json, type RequestHandler } from '@sveltejs/kit';
import { getMeetingsService } from '$lib/server/meet/meetings';

type CreateMeetingBody = {
	title?: string;
	requireApproval?: boolean;
};

/** Start a meeting. Protected — anyone able to create a room can flood LiveKit usage. */
export const POST: RequestHandler = async ({ request, locals, platform, url }) => {
	if (!platform?.env.DB || !locals.user) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	const body = (await request.json().catch(() => ({}))) as CreateMeetingBody;
	const { code, meeting } = await getMeetingsService(platform).create(locals.user.id, {
		title: body.title,
		requireApproval: body.requireApproval
	});

	return json({
		id: meeting.id,
		title: meeting.title,
		requireApproval: meeting.require_approval,
		code,
		joinUrl: `${url.origin}/meet/${code}`
	});
};

export const GET: RequestHandler = async ({ locals, platform }) => {
	if (!platform?.env.DB || !locals.user) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	return json({ meetings: await getMeetingsService(platform).list(locals.user.id) });
};
