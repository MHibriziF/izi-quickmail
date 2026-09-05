import type { D1Database } from '@cloudflare/workers-types';
import type { MailAddress, User } from '$lib/types';
import { APP_NAME } from '$lib/constants';
import { listAddressesForUser } from './domains';
import { escapeHtml, sendOutboundEmail } from './send-mail';
import type { EmailProvider } from './email-provider';

export type SecurityEvent =
	| 'password-changed'
	| 'password-reset'
	| 'reset-requested'
	| 'two-factor-enabled'
	| 'two-factor-disabled'
	| 'backup-codes-reissued'
	| 'recovery-email-changed';

const COPY: Record<SecurityEvent, { subject: string; line: string }> = {
	'password-changed': {
		subject: 'Your password was changed',
		line: 'The password on your mailbox was just changed, and every other signed-in device was signed out.'
	},
	'password-reset': {
		subject: 'Your password was reset',
		line: 'Your password was reset using a recovery link, and every other signed-in device was signed out.'
	},
	'reset-requested': {
		subject: 'Password reset requested',
		line: 'Someone asked to reset the password on your mailbox. The link in the separate email expires shortly.'
	},
	'two-factor-enabled': {
		subject: 'Two-factor authentication is on',
		line: 'Two-factor authentication was turned on. Signing in now needs a code from your authenticator app.'
	},
	'two-factor-disabled': {
		subject: 'Two-factor authentication is off',
		line: 'Two-factor authentication was turned off. Your password is now the only thing protecting the mailbox.'
	},
	'backup-codes-reissued': {
		subject: 'New recovery codes were generated',
		line: 'A new set of two-factor recovery codes was generated. The previous codes no longer work.'
	},
	'recovery-email-changed': {
		subject: 'Your recovery address changed',
		line: 'The recovery address on your mailbox was changed. Future reset links go to the new address.'
	}
};

/** The address a notice is sent from — their own default mailbox. */
async function senderFor(db: D1Database, userId: string): Promise<MailAddress | null> {
	const addresses = await listAddressesForUser(db, userId);
	return addresses.find((address) => address.is_default) ?? addresses[0] ?? null;
}

function body(event: SecurityEvent, mailbox: string): { text: string; html: string } {
	const { line } = COPY[event];
	const text = [
		line,
		'',
		`Mailbox: ${mailbox}`,
		`When: ${new Date().toUTCString()}`,
		'',
		"If this was you, nothing else is needed. If it was not, reset your password and turn off two-factor recovery codes immediately."
	].join('\n');

	const html = `<p>${escapeHtml(line)}</p>
<p><strong>Mailbox:</strong> ${escapeHtml(mailbox)}<br>
<strong>When:</strong> ${escapeHtml(new Date().toUTCString())}</p>
<p>If this was you, nothing else is needed. If it was not, reset your password immediately.</p>`;

	return { text, html };
}

/**
 * Tells the recovery address that something security-relevant happened.
 *
 * Never throws: a notice failing to send must not roll back the change the user
 * actually asked for. The caller has already done the important part.
 */
export async function notifySecurityEvent(
	db: D1Database,
	provider: EmailProvider,
	user: User,
	event: SecurityEvent,
	overrideTo?: string
): Promise<void> {
	try {
		const to =
			overrideTo ??
			(
				await db
					.prepare(
						'SELECT recovery_email FROM users WHERE id = ? AND recovery_email_verified_at IS NOT NULL'
					)
					.bind(user.id)
					.first<{ recovery_email: string | null }>()
			)?.recovery_email;

		if (!to) return;

		const from = await senderFor(db, user.id);
		if (!from) return;

		const { text, html } = body(event, user.email);
		await sendOutboundEmail(provider, {
			from,
			senderName: APP_NAME,
			to,
			subject: `${APP_NAME}: ${COPY[event].subject}`,
			text,
			html
		});
	} catch {
		// Deliberately swallowed — see the doc comment.
	}
}

/** The reset link itself, which goes to the recovery address only. */
export async function sendPasswordResetLink(
	db: D1Database,
	provider: EmailProvider,
	user: User,
	to: string,
	link: string,
	ttlMinutes: number
): Promise<void> {
	const from = await senderFor(db, user.id);
	if (!from) throw new Error('No sending address is configured');

	const text = [
		`Use this link to set a new password for ${user.email}:`,
		'',
		link,
		'',
		`The link expires in ${ttlMinutes} minutes and works once.`,
		'',
		'If you did not ask for this, ignore this email — your password has not changed.'
	].join('\n');

	const html = `<p>Use this link to set a new password for ${escapeHtml(user.email)}:</p>
<p><a href="${escapeHtml(link)}">Set a new password</a></p>
<p>The link expires in ${ttlMinutes} minutes and works once.</p>
<p>If you did not ask for this, ignore this email — your password has not changed.</p>`;

	await sendOutboundEmail(provider, {
		from,
		senderName: APP_NAME,
		to,
		subject: `${APP_NAME}: reset your password`,
		text,
		html
	});
}

/** The click that proves a new recovery address is reachable. */
export async function sendRecoveryVerification(
	db: D1Database,
	provider: EmailProvider,
	user: User,
	to: string,
	link: string
): Promise<void> {
	const from = await senderFor(db, user.id);
	if (!from) throw new Error('No sending address is configured');

	const text = [
		`Confirm this address as the recovery address for ${user.email}:`,
		'',
		link,
		'',
		'Until you do, it cannot be used to reset the password.'
	].join('\n');

	const html = `<p>Confirm this address as the recovery address for ${escapeHtml(user.email)}:</p>
<p><a href="${escapeHtml(link)}">Confirm recovery address</a></p>
<p>Until you do, it cannot be used to reset the password.</p>`;

	await sendOutboundEmail(provider, {
		from,
		senderName: APP_NAME,
		to,
		subject: `${APP_NAME}: confirm your recovery address`,
		text,
		html
	});
}
