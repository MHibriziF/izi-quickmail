import { json, type RequestHandler } from '@sveltejs/kit';
import {
	getUserByEmail,
	startSession,
	sessionCookieOptions,
	setUserName,
	setUserPassword,
	SESSION_COOKIE
} from '$lib/server/auth';
import { SESSION_DAYS } from '$lib/server/constants';
import { verifyPassword } from '$lib/server/crypto';
import { getEmailProvider } from '$lib/server/context';
import { notifySecurityEvent } from '$lib/server/security-notice';

/**
 * The signed-in user editing their own account: display name and password.
 *
 * Session-only by design — `authorizeApiRequest` rejects bearer tokens on any
 * route it does not list, so a leaked `mail:read` key cannot reach this.
 */
export const PATCH: RequestHandler = async ({ request, cookies, locals, platform }) => {
	const db = platform?.env.DB;
	if (!db || !locals.user) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	let body: { name?: unknown; currentPassword?: unknown; newPassword?: unknown };
	try {
		body = (await request.json()) as typeof body;
	} catch {
		return json({ error: 'Invalid request' }, { status: 400 });
	}

	const wantsName = body.name !== undefined;
	const wantsPassword = body.newPassword !== undefined;

	if (!wantsName && !wantsPassword) {
		return json({ error: 'Nothing to update' }, { status: 400 });
	}

	try {
		let user = locals.user;

		if (wantsName) {
			if (typeof body.name !== 'string') {
				return json({ error: 'Name must be text' }, { status: 400 });
			}
			user = await setUserName(db, user.id, body.name);
		}

		if (wantsPassword) {
			if (typeof body.newPassword !== 'string' || typeof body.currentPassword !== 'string') {
				return json({ error: 'Current and new password are required' }, { status: 400 });
			}

			// A stolen session must not be enough to take the account over, so the
			// current password is re-checked even though the caller is signed in.
			const stored = await getUserByEmail(db, user.email);
			if (!stored || !(await verifyPassword(body.currentPassword, stored.password_hash))) {
				return json({ error: 'Current password is incorrect' }, { status: 403 });
			}

			// Rotation drops every session and API token, including the cookie that
			// authorised this request — so mint a fresh one and keep the tab signed in.
			await setUserPassword(db, user.id, body.newPassword);

			const renewed = await startSession(db, user);
			cookies.set(SESSION_COOKIE, renewed.token, sessionCookieOptions(SESSION_DAYS * 24 * 60 * 60));
			user = renewed.user;

			await notifySecurityEvent(db, getEmailProvider(platform), user, 'password-changed');
		}

		return json({ ok: true, user, apiTokensRevoked: wantsPassword });
	} catch (error) {
		return json(
			{ error: error instanceof Error ? error.message : 'Could not update account' },
			{ status: 400 }
		);
	}
};
