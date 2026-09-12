import { json, type RequestHandler } from '@sveltejs/kit';
import { verifyMeetingToken } from '$lib/server/meet/meetings';
import { getLiveKitClient } from '$lib/server/context';

type JoinBody = {
	token?: unknown;
	name?: unknown;
};

/**
 * Join a meeting. Public — the token in the request body is the only
 * credential, matching the emailed link's `?token=` query param.
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

	if (typeof body.token !== 'string' || !body.token) {
		return json({ error: 'Missing token' }, { status: 400 });
	}

	const id = params.id;
	if (!id || !(await verifyMeetingToken(db, id, body.token))) {
		return json({ error: 'That link is invalid or has expired.' }, { status: 403 });
	}

	const name = typeof body.name === 'string' ? body.name.trim().slice(0, 100) : undefined;

	try {
		const liveKit = getLiveKitClient(platform);
		const accessToken = await liveKit.createAccessToken({
			identity: crypto.randomUUID(),
			name,
			room: id
		});

		return json({ url: liveKit.url, token: accessToken, roomName: id });
	} catch (error) {
		return json(
			{ error: error instanceof Error ? error.message : 'Could not join meeting' },
			{ status: 503 }
		);
	}
};
