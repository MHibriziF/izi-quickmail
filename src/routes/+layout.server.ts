import type { LayoutServerLoad } from './$types';
import { getMailboxCounts } from '$lib/server/mail-store';
import { runDueTrashPurge } from '$lib/server/cleanup';
import type { MailboxCounts } from '$lib/types';

const EMPTY_COUNTS: MailboxCounts = {
	inbox: 0,
	inbox_unread: 0,
	starred: 0,
	drafts: 0,
	sent: 0,
	trash: 0
};

export const load: LayoutServerLoad = async ({ locals, platform, depends }) => {
	const db = platform?.env.DB;

	// Reading a thread changes these, but that happens in another route's load,
	// which gives SvelteKit no reason to re-run this one. Naming the dependency
	// lets those routes refresh the badges without a full invalidateAll().
	depends('app:counts');

	// Emptying old trash rides along with a page load rather than a timer. The
	// claim inside is throttled to once a day, so this is a single cheap UPDATE
	// on all but one request in twenty-four hours.
	if (db && locals.user) {
		try {
			await runDueTrashPurge(db, platform?.env.ATTACHMENTS, locals.user.id);
		} catch {
			// Never block the mailbox on housekeeping.
		}
	}

	// The sidebar shows these on every page, so they load with the shell.
	const counts =
		db && locals.user
			? await getMailboxCounts(db, locals.user.id, locals.activeDomainId)
			: EMPTY_COUNTS;

	return {
		user: locals.user,
		domains: locals.domains,
		addresses: locals.addresses,
		activeDomainId: locals.activeDomainId,
		counts
	};
};
