import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { findMeetingByCode } from '$lib/server/meet/meetings';
import { getLiveKitClient } from '$lib/server/context';

type JoinBody = {
	name?: unknown;
};

/**
 * Join a meeting. Public — the code in the URL is the only credential, same
 * as a Google Meet/Zoom meeting code.
 */
export const POST: RequestHandler = async ({ params, request, platform }) => {
	const db = platform?.env.DB;
	if (!db) return json({ error: 'Database unavailable' }, { status: 503 });

	let body: JoinBody;
	try {
		body = (await request.json()) as JoinBody;
	} catch {
		return json({ error: 'Invalid request' }, { status: 400 });
	}

	const meeting = await findMeetingByCode(db, params.code);
	if (!meeting) {
		return json({ error: 'That code is invalid or the meeting no longer exists.' }, { status: 404 });
	}

	const name = typeof body.name === 'string' ? body.name.trim().slice(0, 100) : undefined;

	try {
		const liveKit = getLiveKitClient(platform);
		const accessToken = await liveKit.createAccessToken({
			identity: crypto.randomUUID(),
			name,
			room: meeting.id
		});

		return json({ url: liveKit.url, token: accessToken, roomName: meeting.id });
	} catch (error) {
		return json(
			{ error: error instanceof Error ? error.message : 'Could not join meeting' },
			{ status: 503 }
		);
	}
};
