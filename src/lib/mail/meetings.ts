import { MailRequestError } from './client';

/**
 * Starting a meeting from compose, in one place for both shells — the same
 * reason `sendMessage` lives in `client.ts` rather than being duplicated
 * per-shell.
 */

export type StartedMeeting = {
	id: string;
	title: string | null;
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

/** The HTML appended to a compose body when a meeting is started. */
export function meetingLinkHtml(joinUrl: string): string {
	return `<p><a href="${joinUrl}">Join the video meeting</a></p>`;
}
