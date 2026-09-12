import { json, type RequestHandler } from '@sveltejs/kit';
import { getMailStoreService } from '$lib/server/mail-store';

export const GET: RequestHandler = async ({ params, locals, platform }) => {
	if (!platform?.env.DB || !locals.user) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	const draft = await getMailStoreService(platform).getDraft(locals.user.id, params.id!);
	if (!draft) {
		return json({ error: 'Not found' }, { status: 404 });
	}

	return json({
		id: draft.id,
		to_addr: draft.to_addr,
		cc_addr: draft.cc_addr,
		bcc_addr: draft.bcc_addr,
		subject: draft.subject,
		body_html: draft.body_html,
		body_text: draft.body_text,
		from_addr: draft.from_addr,
		address_id: draft.address_id
	});
};

export const DELETE: RequestHandler = async ({ params, locals, platform }) => {
	if (!platform?.env.DB || !locals.user) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	await getMailStoreService(platform).deleteDraft(locals.user.id, params.id!);

	return json({ ok: true });
};
