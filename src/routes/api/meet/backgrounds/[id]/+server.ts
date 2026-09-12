import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
	deleteCallBackground,
	getCallBackgroundForUser,
	readCallBackgroundBytes
} from '$lib/server/call-backgrounds';

export const GET: RequestHandler = async ({ params, locals, platform }) => {
	if (!locals.user || !platform?.env.DB || !platform?.env.ATTACHMENTS) {
		throw error(401, 'Unauthorized');
	}

	const background = await getCallBackgroundForUser(platform.env.DB, locals.user.id, params.id);
	if (!background) throw error(404, 'Background not found');

	const bytes = await readCallBackgroundBytes(platform.env.ATTACHMENTS, background);
	if (!bytes) throw error(404, 'Background not found');

	const body = new Uint8Array(bytes);

	return new Response(body, {
		headers: {
			'Content-Type': background.content_type,
			'Content-Disposition': 'inline',
			'Content-Length': String(bytes.length),
			'Cache-Control': 'private, max-age=86400'
		}
	});
};

export const DELETE: RequestHandler = async ({ params, locals, platform }) => {
	if (!locals.user || !platform?.env.DB || !platform?.env.ATTACHMENTS) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	const deleted = await deleteCallBackground(platform.env.DB, platform.env.ATTACHMENTS, locals.user.id, params.id);
	if (!deleted) return json({ error: 'Background not found' }, { status: 404 });

	return json({ ok: true });
};
