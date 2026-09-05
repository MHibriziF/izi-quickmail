import { json, type RequestHandler } from '@sveltejs/kit';
import { isValidTimeZone } from '$lib/timezone';

/** Null means "follow this browser", which is right until you travel. */
export const POST: RequestHandler = async ({ request, locals, platform }) => {
	const db = platform?.env.DB;
	if (!db || !locals.user) return json({ error: 'Unauthorized' }, { status: 401 });

	let body: { timeZone?: unknown };
	try {
		body = (await request.json()) as typeof body;
	} catch {
		return json({ error: 'Invalid request' }, { status: 400 });
	}

	const value = body.timeZone;
	if (value !== null && typeof value !== 'string') {
		return json({ error: 'Pick a time zone' }, { status: 400 });
	}

	// Validated rather than trusted: this string is handed straight to Intl,
	// which throws on a name it does not know.
	if (typeof value === 'string' && !isValidTimeZone(value)) {
		return json({ error: 'That is not a known time zone' }, { status: 400 });
	}

	await db
		.prepare('UPDATE users SET timezone = ? WHERE id = ?')
		.bind(value || null, locals.user.id)
		.run();

	return json({ ok: true, timeZone: value || null });
};
