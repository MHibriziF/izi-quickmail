import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { findMeetingByCode } from '$lib/server/meet/meetings';
import { getAdmission } from '$lib/server/meet/admissions';
import { getLiveKitClient } from '$lib/server/context';

/**
 * Polled by a guest waiting to be let in. Public — the admission id is itself
 * the credential, same trust level as the join code. Mints the LiveKit token
 * right here once admitted, so the guest's poll loop doesn't need a second
 * round trip.
 */
export const GET: RequestHandler = async ({ params, url, platform }) => {
	const db = platform?.env.DB;
	if (!db) return json({ error: 'Database unavailable' }, { status: 503 });

	const meeting = await findMeetingByCode(db, params.code);
	if (!meeting) return json({ error: 'That code is invalid or the meeting no longer exists.' }, { status: 404 });

	const admission = await getAdmission(db, meeting.id, params.admissionId);
	if (!admission) return json({ error: 'Admission request not found' }, { status: 404 });

	if (admission.status !== 'admitted') {
		return json({ status: admission.status });
	}

	const name = url.searchParams.get('name')?.trim().slice(0, 100) || undefined;

	try {
		const liveKit = getLiveKitClient(platform);
		const accessToken = await liveKit.createAccessToken({
			identity: crypto.randomUUID(),
			name,
			room: meeting.id
		});

		return json({ status: 'admitted', url: liveKit.url, token: accessToken, roomName: meeting.id });
	} catch (error) {
		return json(
			{ error: error instanceof Error ? error.message : 'Could not join meeting' },
			{ status: 503 }
		);
	}
};
