import { json, type RequestHandler } from '@sveltejs/kit';
import { getApiTokenService } from '$lib/server/api-tokens';

export const DELETE: RequestHandler = async ({ locals, platform, params }) => {
	if (!platform?.env.DB || !locals.user) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}
	const apiTokens = getApiTokenService(platform);

	const removed = await apiTokens.revokeApiToken(locals.user.id, params.id!);
	if (!removed) {
		return json({ error: 'Token not found' }, { status: 404 });
	}

	return json({ ok: true, tokens: await apiTokens.listApiTokens(locals.user.id) });
};
