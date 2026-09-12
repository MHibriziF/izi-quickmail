import { json, type RequestHandler } from '@sveltejs/kit';
import { getAuthService } from '$lib/server/auth';
import { getEmailProvider } from '$lib/server/context';
import { notifySecurityEvent } from '$lib/server/outbound/security-notice';

/**
 * Finish a password reset. Public, and the token is the only credential.
 *
 * Note what this deliberately does not do: it does not sign anyone in. The
 * caller goes to the login page afterwards, so two-factor is still enforced —
 * reaching the recovery inbox must not be a way around the second factor.
 */
export const POST: RequestHandler = async ({ request, platform }) => {
	const db = platform?.env.DB;
	if (!db) return json({ error: 'Database unavailable' }, { status: 503 });
	const auth = getAuthService(platform);

	let body: { token?: unknown; password?: unknown };
	try {
		body = (await request.json()) as typeof body;
	} catch {
		return json({ error: 'Invalid request' }, { status: 400 });
	}

	if (typeof body.token !== 'string' || typeof body.password !== 'string') {
		return json({ error: 'Missing token or password' }, { status: 400 });
	}

	const userId = await auth.consumeToken('password_reset', body.token);
	if (!userId) {
		return json({ error: 'That link has expired or already been used.' }, { status: 400 });
	}

	try {
		// Also drops every session and API token for the account.
		await auth.setUserPassword(userId, body.password);
	} catch (error) {
		return json(
			{ error: error instanceof Error ? error.message : 'Could not set that password' },
			{ status: 400 }
		);
	}

	const user = await auth.getUserById(userId);
	if (user) {
		try {
			await notifySecurityEvent(db, getEmailProvider(platform), user, 'password-reset');
		} catch {
			// The password is already changed; a missing notice must not fail it.
		}
	}

	return json({ ok: true });
};
