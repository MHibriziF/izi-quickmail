import { json, type RequestHandler } from '@sveltejs/kit';
import { getAuthService } from '$lib/server/auth';
import { verifyPassword } from '$lib/server/util/crypto';
import { getEmailProvider } from '$lib/server/context';
import { notifySecurityEvent, sendRecoveryVerification } from '$lib/server/outbound/security-notice';

export const GET: RequestHandler = async ({ locals, platform }) => {
	if (!platform?.env.DB || !locals.user) return json({ error: 'Unauthorized' }, { status: 401 });

	return json(await getAuthService(platform).getRecoveryStatus(locals.user.id));
};

/**
 * Set or clear the recovery address.
 *
 * The password is re-checked because a borrowed session must not be enough to
 * point recovery somewhere else — that would be a takeover that survives the
 * session being revoked.
 */
export const POST: RequestHandler = async ({ request, url, locals, platform }) => {
	if (!platform?.env.DB || !locals.user) return json({ error: 'Unauthorized' }, { status: 401 });
	const auth = getAuthService(platform);

	let body: { email?: unknown; password?: unknown; action?: unknown };
	try {
		body = (await request.json()) as typeof body;
	} catch {
		return json({ error: 'Invalid request' }, { status: 400 });
	}

	if (typeof body.password !== 'string' || !body.password) {
		return json({ error: 'Your password is required' }, { status: 400 });
	}

	const stored = await auth.getUserByEmail(locals.user.email);
	if (!stored || !(await verifyPassword(body.password, stored.passwordHash))) {
		return json({ error: 'That password is incorrect' }, { status: 403 });
	}

	try {
		if (body.action === 'clear') {
			const previous = await auth.getRecoveryStatus(locals.user.id);
			await auth.clearRecoveryEmail(locals.user.id);
			if (previous.email) {
				await notifySecurityEvent(
					platform.env.DB,
					getEmailProvider(platform),
					locals.user,
					'recovery-email-changed',
					previous.email
				);
			}
			return json({ ok: true, ...(await auth.getRecoveryStatus(locals.user.id)) });
		}

		if (typeof body.email !== 'string') {
			return json({ error: 'Enter an email address' }, { status: 400 });
		}

		const provider = getEmailProvider(platform);
		const token = await auth.startRecoveryEmailChange(locals.user.id, body.email);
		const link = `${url.origin}/account/recovery?token=${encodeURIComponent(token)}`;

		await sendRecoveryVerification(platform.env.DB, provider, locals.user, body.email.trim(), link);

		return json({ ok: true, ...(await auth.getRecoveryStatus(locals.user.id)) });
	} catch (error) {
		return json(
			{ error: error instanceof Error ? error.message : 'Could not update the recovery address' },
			{ status: 400 }
		);
	}
};
