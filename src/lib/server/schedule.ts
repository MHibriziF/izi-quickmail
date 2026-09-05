import { MAX_SCHEDULE_DAYS } from '$lib/constants';

/**
 * Validates a requested send time.
 *
 * Shared by the compose and reply endpoints so the two cannot drift: a past
 * time would send immediately, which is never what someone picking a date
 * meant, and the provider refuses anything past its own horizon.
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
	if (when.getTime() > Date.now() + MAX_SCHEDULE_DAYS * 24 * 60 * 60 * 1000) {
		return { error: `Scheduled send only reaches ${MAX_SCHEDULE_DAYS} days ahead` };
	}

	return { iso: when.toISOString() };
}
