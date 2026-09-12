import { MailRequestError } from './client';

/**
 * Starting a meeting from compose, in one place for both shells — the same
 * reason `sendMessage` lives in `client.ts` rather than being duplicated
 * per-shell.
 */

export type StartedMeeting = {
	id: string;
	title: string | null;
	code: string;
	joinUrl: string;
};

export async function startMeeting(title?: string): Promise<StartedMeeting> {
	const response = await fetch('/api/meetings', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ title })
	});

	const payload = (await response.json().catch(() => ({}))) as StartedMeeting & { error?: string };
	if (!response.ok) {
		throw new MailRequestError(response.status, payload.error ?? 'Could not start meeting');
	}

	return payload;
}

/** The HTML appended to a compose body when a meeting is started. The code is printed in the clear too, so a recipient can type it in instead of clicking. */
export function meetingLinkHtml(joinUrl: string, code: string): string {
	return `<p><a href="${joinUrl}">Join the video meeting</a></p><p>Or enter this code: <strong>${code}</strong></p>`;
}
