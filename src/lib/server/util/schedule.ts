import { MAX_SCHEDULE_YEARS } from '$lib/constants';

/** Milliseconds beyond which a send time is treated as a mistyped year. */
const MAX_SCHEDULE_MS = MAX_SCHEDULE_YEARS * 365 * 24 * 60 * 60 * 1000;

/**
 * Validates a requested send time.
 *
 * Shared by the compose and reply endpoints so the two cannot drift: a past
 * time would send immediately, which is never what someone picking a date
 * meant. There is no upper bound worth enforcing beyond a typo guard — the
 * message waits in our own outbox, not on a provider that caps how long it
 * will hold one.
 */
export function parseScheduledAt(
	value: unknown
): { iso: string | null; error?: undefined } | { iso?: undefined; error: string } {
	if (value === undefined || value === null || value === '') return { iso: null };
	if (typeof value !== 'string') return { error: 'That send time is not a valid date' };

	const when = new Date(value);
	if (Number.isNaN(when.getTime())) {
		return { error: 'That send time is not a valid date' };
	}
	if (when.getTime() <= Date.now()) {
		return { error: 'Pick a time in the future' };
	}
	if (when.getTime() > Date.now() + MAX_SCHEDULE_MS) {
		return { error: `Pick a time within the next ${MAX_SCHEDULE_YEARS} years` };
	}

	return { iso: when.toISOString() };
}
