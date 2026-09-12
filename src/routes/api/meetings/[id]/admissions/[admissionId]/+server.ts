import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getMeetingForUser } from '$lib/server/meet/meetings';
import { setAdmissionStatus } from '$lib/server/meet/admissions';

type AdmissionActionBody = {
	action?: unknown;
};

/** Admit or deny one pending join request — owner-only. */
export const POST: RequestHandler = async ({ params, request, locals, platform }) => {
	const db = platform?.env.DB;
	if (!db || !locals.user) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	const meeting = await getMeetingForUser(db, locals.user.id, params.id);
	if (!meeting) return json({ error: 'Meeting not found' }, { status: 404 });

	const body = (await request.json().catch(() => ({}))) as AdmissionActionBody;
	if (body.action !== 'admit' && body.action !== 'deny') {
		return json({ error: 'Invalid action' }, { status: 400 });
	}

	const status = body.action === 'admit' ? 'admitted' : 'denied';
	const updated = await setAdmissionStatus(db, params.id, params.admissionId, status);
	if (!updated) return json({ error: 'Request not found' }, { status: 404 });

	return json({ ok: true });
};
