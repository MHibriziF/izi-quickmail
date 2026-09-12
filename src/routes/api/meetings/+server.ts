import { json, type RequestHandler } from '@sveltejs/kit';
import { createMeeting, listMeetings } from '$lib/server/meet/meetings';

type CreateMeetingBody = {
	title?: string;
};

/** Start a meeting. Protected — anyone able to create a room can flood LiveKit usage. */
export const POST: RequestHandler = async ({ request, locals, platform, url }) => {
	const db = platform?.env.DB;
	if (!db || !locals.user) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	const body = (await request.json().catch(() => ({}))) as CreateMeetingBody;
	const { token, meeting } = await createMeeting(db, locals.user.id, { title: body.title });

	return json({
		id: meeting.id,
		title: meeting.title,
		joinUrl: `${url.origin}/meet/${meeting.id}?token=${encodeURIComponent(token)}`
	});
};

export const GET: RequestHandler = async ({ locals, platform }) => {
	const db = platform?.env.DB;
	if (!db || !locals.user) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	return json({ meetings: await listMeetings(db, locals.user.id) });
};
