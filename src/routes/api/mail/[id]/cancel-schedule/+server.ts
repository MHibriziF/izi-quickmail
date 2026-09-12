import { json, type RequestHandler } from '@sveltejs/kit';
import { getMailStoreService } from '$lib/server/mail-store';
import { cancelScheduledSend } from '$lib/server/scheduled-send';

/**
 * Recall a scheduled message.
 *
 * Nothing has left the building — the message is waiting in our own outbox —
 * so this is a local state change. It only succeeds while the row is still
 * `scheduled`: once the sweep has claimed it, the message is on its way and
 * must stay sent mail rather than reappearing as a draft the sender thinks
 * never went out.
 */
export const POST: RequestHandler = async ({ params, locals, platform }) => {
	const db = platform?.env.DB;
	if (!db || !locals.user) return json({ error: 'Unauthorized' }, { status: 401 });

	const email = await getMailStoreService(platform).getEmailForUser(locals.user.id, params.id!);
	if (!email) return json({ error: 'Message not found' }, { status: 404 });

	if (email.status !== 'scheduled' || !email.scheduled_at) {
		return json({ error: 'That message is not scheduled' }, { status: 400 });
	}

	// Back to a draft, so the writing is not thrown away with the schedule.
	if (!(await cancelScheduledSend(db, locals.user.id, email.id))) {
		return json({ error: 'That message has already been sent' }, { status: 409 });
	}

	return json({ ok: true, draftId: email.id });
};
