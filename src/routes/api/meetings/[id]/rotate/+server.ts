import { json, type RequestHandler } from '@sveltejs/kit';
import { rotateMeetingToken } from '$lib/server/meet/meetings';

/**
 * Mints a fresh join link for an existing meeting. The raw token is never
 * persisted, so this is the only way to get a working link for a room again
 * once the original email is gone.
 */
export const POST: RequestHandler = async ({ params, locals, platform, url }) => {
	const db = platform?.env.DB;
	if (!db || !locals.user) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	const id = params.id;
	if (!id) return json({ error: 'Missing meeting id' }, { status: 400 });

	const token = await rotateMeetingToken(db, locals.user.id, id);
	if (!token) return json({ error: 'Meeting not found' }, { status: 404 });

	return json({ joinUrl: `${url.origin}/meet/${id}?token=${encodeURIComponent(token)}` });
};
