import type { PageServerLoad } from './$types';
import { getUserById } from '$lib/server/auth';
import { getEmailProvider } from '$lib/server/context';
import { confirmRecoveryEmail, consumeToken } from '$lib/server/account-recovery';
import { notifySecurityEvent } from '$lib/server/outbound/security-notice';

/** Clicking the link is the whole confirmation — there is nothing to submit. */
export const load: PageServerLoad = async ({ url, platform }) => {
	const db = platform?.env.DB;
	const token = url.searchParams.get('token');

	if (!db || !token) return { confirmed: false, email: null };

	const userId = await consumeToken(db, 'recovery_email', token);
	if (!userId) return { confirmed: false, email: null };

	const email = await confirmRecoveryEmail(db, userId);
	if (!email) return { confirmed: false, email: null };

	const user = await getUserById(db, userId);
	if (user) {
		try {
			await notifySecurityEvent(db, getEmailProvider(platform), user, 'recovery-email-changed');
		} catch {
			// Confirmation already succeeded.
		}
	}

	return { confirmed: true, email };
};
