import type { PageServerLoad } from './$types';
import { getMeetingsService } from '$lib/server/meet/meetings';

export const load: PageServerLoad = async ({ locals, platform }) => {
	const meetings =
		locals.user && platform?.env.DB ? await getMeetingsService(platform).list(locals.user.id) : [];
	return { meetings };
};
