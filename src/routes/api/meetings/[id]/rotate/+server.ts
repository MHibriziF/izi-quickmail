import { json, type RequestHandler } from '@sveltejs/kit';
import { getMeetingsService } from '$lib/server/meet/meetings';

/**
 * Mints a fresh join code for an existing meeting, e.g. after the old one was
 * shared too widely. Keyed by the internal (owner-only) meeting id, not the
 * public code — this is an owner action.
 */
export const POST: RequestHandler = async ({ params, locals, platform, url }) => {
	if (!platform?.env.DB || !locals.user) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	const id = params.id;
	if (!id) return json({ error: 'Missing meeting id' }, { status: 400 });

	const code = await getMeetingsService(platform).rotateCode(locals.user.id, id);
	if (!code) return json({ error: 'Meeting not found' }, { status: 404 });

	return json({ code, joinUrl: `${url.origin}/meet/${code}` });
};
