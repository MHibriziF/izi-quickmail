import { json, type RequestHandler } from '@sveltejs/kit';
import { getAuthService } from '$lib/server/auth';
import { verifyPassword } from '$lib/server/util/crypto';
import { APP_NAME } from '$lib/constants';
import { getEmailProvider } from '$lib/server/context';
import { notifySecurityEvent } from '$lib/server/outbound/security-notice';

/**
 * The signed-in user managing their own second factor.
 *
 * Session-only: `authorizeApiRequest` refuses bearer tokens on unlisted routes,
 * so an API key cannot disarm the account's 2FA.
 */
export const GET: RequestHandler = async ({ locals, platform }) => {
	if (!platform?.env.DB || !locals.user) return json({ error: 'Unauthorized' }, { status: 401 });

	return json(await getAuthService(platform).getTwoFactorStatus(locals.user.id));
};

export const POST: RequestHandler = async ({ request, locals, platform }) => {
	if (!platform?.env.DB || !locals.user) return json({ error: 'Unauthorized' }, { status: 401 });
	const auth = getAuthService(platform);

	let body: { action?: unknown; code?: unknown; password?: unknown };
	try {
		body = (await request.json()) as typeof body;
	} catch {
		return json({ error: 'Invalid request' }, { status: 400 });
	}

	/** Anything destructive re-checks the password, not just the session. */
	const passwordOk = async () => {
		if (typeof body.password !== 'string' || !body.password) return false;
		const stored = await auth.getUserByEmail(locals.user!.email);
		return Boolean(stored) && verifyPassword(body.password, stored!.passwordHash);
	};

	try {
		switch (body.action) {
			case 'start': {
				const { secret, uri } = await auth.startEnrollment(
					locals.user.id,
					locals.user.email,
					APP_NAME
				);
				return json({ secret, uri });
			}

			case 'confirm': {
				if (typeof body.code !== 'string') {
					return json({ error: 'Enter the 6-digit code' }, { status: 400 });
				}
				const backupCodes = await auth.confirmEnrollment(locals.user.id, body.code);
				await notifySecurityEvent(platform.env.DB, getEmailProvider(platform), locals.user, 'two-factor-enabled');
				return json({ ok: true, backupCodes });
			}

			case 'regenerate-codes': {
				if (!(await auth.isTwoFactorEnabled(locals.user.id))) {
					return json({ error: 'Two-factor authentication is off' }, { status: 400 });
				}
				if (!(await passwordOk())) {
					return json({ error: 'That password is incorrect' }, { status: 403 });
				}
				const reissued = await auth.issueBackupCodes(locals.user.id);
				await notifySecurityEvent(
					platform.env.DB,
					getEmailProvider(platform),
					locals.user,
					'backup-codes-reissued'
				);
				return json({ ok: true, backupCodes: reissued });
			}

			case 'disable': {
				if (!(await passwordOk())) {
					return json({ error: 'That password is incorrect' }, { status: 403 });
				}
				await auth.disableTwoFactor(locals.user.id);
				await notifySecurityEvent(
					platform.env.DB,
					getEmailProvider(platform),
					locals.user,
					'two-factor-disabled'
				);
				return json({ ok: true });
			}

			default:
				return json({ error: 'Unknown action' }, { status: 400 });
		}
	} catch (error) {
		return json(
			{ error: error instanceof Error ? error.message : 'Could not update two-factor' },
			{ status: 400 }
		);
	}
};
