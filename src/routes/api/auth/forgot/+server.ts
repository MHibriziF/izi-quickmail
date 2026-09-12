import { json, type RequestHandler } from '@sveltejs/kit';
import { getAuthService, PASSWORD_RESET_TTL_MINUTES } from '$lib/server/auth';
import { getEmailProvider } from '$lib/server/context';
import { notifySecurityEvent, sendPasswordResetLink } from '$lib/server/outbound/security-notice';

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
	const auth = getAuthService(platform);

	let body: { email?: unknown };
	try {
		body = (await request.json()) as typeof body;
	} catch {
		return json(ACCEPTED);
	}

	if (typeof body.email !== 'string' || !body.email.trim()) {
		return json(ACCEPTED);
	}

	const target = await auth.findResetTarget(body.email);
	if (!target) return json(ACCEPTED);

	// Rate limit: one live link at a time, so this cannot be used to mail
	// someone repeatedly.
	if (await auth.hasRecentResetToken(target.userId)) return json(ACCEPTED);

	const user = await auth.getUserById(target.userId);
	if (!user) return json(ACCEPTED);

	try {
		const provider = getEmailProvider(platform);
		const token = await auth.createPasswordResetToken(user.id);
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
