import { json, type RequestHandler } from '@sveltejs/kit';
import { getUserByEmail } from '$lib/server/auth';
import { verifyPassword } from '$lib/server/crypto';
import { getEmailProvider } from '$lib/server/context';
import {
	clearRecoveryEmail,
	getRecoveryStatus,
	startRecoveryEmailChange
} from '$lib/server/account-recovery';
import { notifySecurityEvent, sendRecoveryVerification } from '$lib/server/security-notice';

export const GET: RequestHandler = async ({ locals, platform }) => {
	const db = platform?.env.DB;
	if (!db || !locals.user) return json({ error: 'Unauthorized' }, { status: 401 });

	return json(await getRecoveryStatus(db, locals.user.id));
};

/**
 * Set or clear the recovery address.
 *
 * The password is re-checked because a borrowed session must not be enough to
 * point recovery somewhere else — that would be a takeover that survives the
 * session being revoked.
 */
export const POST: RequestHandler = async ({ request, url, locals, platform }) => {
	const db = platform?.env.DB;
	if (!db || !locals.user) return json({ error: 'Unauthorized' }, { status: 401 });

	let body: { email?: unknown; password?: unknown; action?: unknown };
	try {
		body = (await request.json()) as typeof body;
	} catch {
		return json({ error: 'Invalid request' }, { status: 400 });
	}

	if (typeof body.password !== 'string' || !body.password) {
		return json({ error: 'Your password is required' }, { status: 400 });
	}

	const stored = await getUserByEmail(db, locals.user.email);
	if (!stored || !(await verifyPassword(body.password, stored.password_hash))) {
		return json({ error: 'That password is incorrect' }, { status: 403 });
	}

	try {
		if (body.action === 'clear') {
			const previous = await getRecoveryStatus(db, locals.user.id);
			await clearRecoveryEmail(db, locals.user.id);
			if (previous.email) {
				await notifySecurityEvent(
					db,
					getEmailProvider(platform),
					locals.user,
					'recovery-email-changed',
					previous.email
				);
			}
			return json({ ok: true, ...(await getRecoveryStatus(db, locals.user.id)) });
		}

		if (typeof body.email !== 'string') {
			return json({ error: 'Enter an email address' }, { status: 400 });
		}

		const provider = getEmailProvider(platform);
		const token = await startRecoveryEmailChange(db, locals.user.id, body.email);
		const link = `${url.origin}/account/recovery?token=${encodeURIComponent(token)}`;

		await sendRecoveryVerification(db, provider, locals.user, body.email.trim(), link);

		return json({ ok: true, ...(await getRecoveryStatus(db, locals.user.id)) });
	} catch (error) {
		return json(
			{ error: error instanceof Error ? error.message : 'Could not update the recovery address' },
			{ status: 400 }
		);
	}
};
