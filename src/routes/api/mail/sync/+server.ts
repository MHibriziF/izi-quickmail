import { json, type RequestHandler } from '@sveltejs/kit';
import { getMailStoreService } from '$lib/server/mail-store';
import { MAILBOX_SYNC_HOLD_MS, MAILBOX_SYNC_TICK_MS, waitForAbortable } from '$lib/mail/sync';

/**
 * Long-poll for mailbox inserts/deletes. The inbound webhook and this request
 * run on different Worker isolates, so we watch D1 instead of pushing from
 * the receive path.
 */
export const GET: RequestHandler = async ({ locals, platform, url, request }) => {
	if (!platform?.env.DB || !locals.user) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	const mailStore = getMailStoreService(platform);
	const held = url.searchParams.get('cursor');
	let cursor = await mailStore.getMailboxCursor(locals.user.id, locals.activeDomainId);
	const deadline = Date.now() + MAILBOX_SYNC_HOLD_MS;

	while (held && cursor === held && Date.now() < deadline) {
		const stillOpen = await waitForAbortable(MAILBOX_SYNC_TICK_MS, request.signal);
		if (!stillOpen) break;
		cursor = await mailStore.getMailboxCursor(locals.user.id, locals.activeDomainId);
	}

	return json(
		{ cursor },
		{
			headers: {
				'Cache-Control': 'no-store'
			}
		}
	);
};
