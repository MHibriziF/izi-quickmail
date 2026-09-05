import { json, type RequestHandler } from '@sveltejs/kit';
import { getUserById } from '$lib/server/auth';
import { getEmailProvider } from '$lib/server/context';
import {
	PASSWORD_RESET_TTL_MINUTES,
	createPasswordResetToken,
	findResetTarget,
	hasRecentResetToken
} from '$lib/server/account-recovery';
import { notifySecurityEvent, sendPasswordResetLink } from '$lib/server/security-notice';

/** Said no matter what happened, so the response reveals nothing. */
const ACCEPTED = {
	ok: true,
	message: 'If that mailbox has a verified recovery address, a reset link is on its way.'
};

/**
 * Start a password reset. Public and unauthenticated.
 *
 * Every path returns the same body and status: whether the mailbox exists,
 * whether it has a recovery address, and whether sending worked are all
 * invisible to the caller. Anything else turns this into an account oracle.
 */
export const POST: RequestHandler = async ({ request, url, platform }) => {
	const db = platform?.env.DB;
	if (!db) return json({ error: 'Database unavailable' }, { status: 503 });

	let body: { email?: unknown };
	try {
		body = (await request.json()) as typeof body;
	} catch {
		return json(ACCEPTED);
	}

	if (typeof body.email !== 'string' || !body.email.trim()) {
		return json(ACCEPTED);
	}

	const target = await findResetTarget(db, body.email);
	if (!target) return json(ACCEPTED);

	// Rate limit: one live link at a time, so this cannot be used to mail
	// someone repeatedly.
	if (await hasRecentResetToken(db, target.userId)) return json(ACCEPTED);

	const user = await getUserById(db, target.userId);
	if (!user) return json(ACCEPTED);

	try {
		const provider = getEmailProvider(platform);
		const token = await createPasswordResetToken(db, user.id);
		const link = `${url.origin}/reset?token=${encodeURIComponent(token)}`;

		await sendPasswordResetLink(
			db,
			provider,
			user,
			target.recoveryEmail,
			link,
			PASSWORD_RESET_TTL_MINUTES
		);
		await notifySecurityEvent(db, provider, user, 'reset-requested', target.recoveryEmail);
	} catch {
		// Still ACCEPTED — a provider outage must not tell the caller the
		// mailbox exists.
	}

	return json(ACCEPTED);
};
