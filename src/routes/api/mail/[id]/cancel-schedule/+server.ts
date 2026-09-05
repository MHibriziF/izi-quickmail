import { json, type RequestHandler } from '@sveltejs/kit';
import { getEmailProvider } from '$lib/server/context';
import { getEmailForUser } from '$lib/server/mail-store';

/**
 * Recall a scheduled message.
 *
 * The provider is asked first: if it has already released the message, the row
 * must stay as sent mail rather than reappearing as an unsent draft the person
 * thinks never went out.
 */
export const POST: RequestHandler = async ({ params, locals, platform }) => {
	const db = platform?.env.DB;
	if (!db || !locals.user) return json({ error: 'Unauthorized' }, { status: 401 });

	const email = await getEmailForUser(db, locals.user.id, params.id!);
	if (!email) return json({ error: 'Message not found' }, { status: 404 });

	if (email.status !== 'scheduled' || !email.scheduled_at) {
		return json({ error: 'That message is not scheduled' }, { status: 400 });
	}

	const provider = getEmailProvider(platform);
	if (!provider.cancelScheduled) {
		return json({ error: 'This provider cannot recall a scheduled message' }, { status: 400 });
	}

	if (!email.provider_id) {
		return json({ error: 'That message has no provider reference' }, { status: 400 });
	}

	try {
		await provider.cancelScheduled(email.provider_id);
	} catch (error) {
		return json(
			{
				error:
					error instanceof Error
						? `Could not recall it — ${error.message}`
						: 'Could not recall that message'
			},
			{ status: 400 }
		);
	}

	// Back to a draft, so the writing is not thrown away with the schedule.
	await db
		.prepare(
			`UPDATE emails
			    SET status = 'draft', scheduled_at = NULL, provider_id = NULL,
			        status_at = datetime('now')
			  WHERE id = ? AND user_id = ?`
		)
		.bind(email.id, locals.user.id)
		.run();

	return json({ ok: true, draftId: email.id });
};
