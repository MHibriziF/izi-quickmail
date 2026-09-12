import type { PageServerLoad } from './$types';

// Even with ssr disabled below, a server load still runs once on the initial
// request — this is the only way to know who is visiting before the client
// takes over, so a signed-in host does not have to retype their own name.
export const load: PageServerLoad = ({ locals }) => {
	return { userName: locals.user?.name ?? null, isLoggedIn: !!locals.user };
};
