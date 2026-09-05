import { json, type RequestHandler } from '@sveltejs/kit';
import { suggestRecipients } from '$lib/server/recipients';

/** Typeahead for the compose recipient fields. Session-only, like settings. */
export const GET: RequestHandler = async ({ url, locals, platform }) => {
	const db = platform?.env.DB;
	if (!db || !locals.user) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	const suggestions = await suggestRecipients(db, locals.user.id, url.searchParams.get('q') ?? '');
	return json({ suggestions });
};
