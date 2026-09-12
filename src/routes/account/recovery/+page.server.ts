import type { PageServerLoad } from './$types';
import { getAuthService } from '$lib/server/auth';
import { getEmailProvider } from '$lib/server/context';
import { notifySecurityEvent } from '$lib/server/outbound/security-notice';

/** Clicking the link is the whole confirmation — there is nothing to submit. */
export const load: PageServerLoad = async ({ url, platform }) => {
	const db = platform?.env.DB;
	const token = url.searchParams.get('token');

	if (!db || !token) return { confirmed: false, email: null };
	const auth = getAuthService(platform);

	const userId = await auth.consumeToken('recovery_email', token);
	if (!userId) return { confirmed: false, email: null };

	const email = await auth.confirmRecoveryEmail(userId);
	if (!email) return { confirmed: false, email: null };

	const user = await auth.getUserById(userId);
	if (user) {
		try {
			await notifySecurityEvent(db, getEmailProvider(platform), user, 'recovery-email-changed');
		} catch {
			// Confirmation already succeeded.
		}
	}

	return { confirmed: true, email };
};
