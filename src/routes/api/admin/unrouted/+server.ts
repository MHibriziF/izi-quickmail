import { json, type RequestHandler } from '@sveltejs/kit';
import { getDomainsService } from '$lib/server/domains';

export const GET: RequestHandler = async ({ locals, platform, url }) => {
	if (!locals.user?.is_admin) {
		return json({ error: 'Forbidden' }, { status: 403 });
	}

	if (!platform?.env.DB) return json({ error: 'Database unavailable' }, { status: 503 });

	const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 50));
	return json({ unrouted: await getDomainsService(platform).listUnroutedEmails(limit) });
};
