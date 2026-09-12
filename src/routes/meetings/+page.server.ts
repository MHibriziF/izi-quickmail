import type { PageServerLoad } from './$types';
import { listMeetings } from '$lib/server/meet/meetings';

export const load: PageServerLoad = async ({ locals, platform }) => {
	const db = platform?.env.DB;
	const meetings = locals.user && db ? await listMeetings(db, locals.user.id) : [];
	return { meetings };
};
