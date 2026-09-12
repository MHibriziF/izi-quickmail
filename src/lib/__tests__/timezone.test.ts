import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
	fromLocalInputValue,
	instantFromWall,
	isValidTimeZone,
	toLocalInputValue,
	zonedHour,
	zonedWeekday
} from '../timezone';

const JAKARTA = 'Asia/Jakarta'; // UTC+7 all year — no DST to confuse things.
const NEW_YORK = 'America/New_York'; // UTC-5 in winter, UTC-4 in summer.

describe('wall time in a named zone', () => {
	test('a fixed-offset zone resolves to the right instant', () => {
		const instant = instantFromWall(
			{ year: 2026, month: 9, day: 6, hour: 13, minute: 0 },
			JAKARTA
		);
		// 13:00 in Jakarta is 06:00 UTC.
		assert.equal(instant.toISOString(), '2026-09-06T06:00:00.000Z');
	});

	test('the same wall time maps differently either side of a DST change', () => {
		const winter = instantFromWall({ year: 2026, month: 1, day: 15, hour: 12 }, NEW_YORK);
		const summer = instantFromWall({ year: 2026, month: 7, day: 15, hour: 12 }, NEW_YORK);

		// Noon is 17:00 UTC on standard time and 16:00 UTC on daylight time. A
		// fixed offset would get one of these wrong.
		assert.equal(winter.toISOString(), '2026-01-15T17:00:00.000Z');
		assert.equal(summer.toISOString(), '2026-07-15T16:00:00.000Z');
	});

	test('midnight does not roll into the previous day', () => {
		const instant = instantFromWall({ year: 2026, month: 9, day: 6, hour: 0 }, JAKARTA);
		assert.equal(instant.toISOString(), '2026-09-05T17:00:00.000Z');
		assert.equal(toLocalInputValue(instant, JAKARTA), '2026-09-06T00:00');
	});
});

describe('picking an hour relative to today', () => {
	// 2026-09-06T20:00Z is already 2026-09-07 03:00 in Jakarta — the zone is a
	// day ahead of UTC at that moment, which is exactly the case that breaks a
	// naive implementation.
	const lateUtc = new Date('2026-09-06T20:00:00.000Z');

	test("uses the zone's own date, not the host's", () => {
		const eightAm = zonedHour(JAKARTA, 0, 8, lateUtc);
		// Today in Jakarta is the 7th, so 08:00 there is 01:00 UTC on the 7th.
		assert.equal(eightAm.toISOString(), '2026-09-07T01:00:00.000Z');
	});

	test('a day offset moves whole days in that zone', () => {
		const tomorrow = zonedHour(JAKARTA, 1, 8, lateUtc);
		assert.equal(tomorrow.toISOString(), '2026-09-08T01:00:00.000Z');
	});

	test('offsets roll over a month boundary', () => {
		const endOfMonth = new Date('2026-09-30T02:00:00.000Z');
		const tomorrow = zonedHour(JAKARTA, 1, 8, endOfMonth);
		assert.equal(tomorrow.toISOString(), '2026-10-01T01:00:00.000Z');
	});

	test('the weekday is the one that zone is having', () => {
		// 2026-09-06T20:00Z is Sunday in UTC but already Monday in Jakarta.
		assert.equal(zonedWeekday('UTC', lateUtc), 0);
		assert.equal(zonedWeekday(JAKARTA, lateUtc), 1);
	});
});

describe('datetime-local values', () => {
	test('round-trips through the chosen zone', () => {
		const instant = fromLocalInputValue('2026-09-06T13:30', JAKARTA);
		assert.ok(instant);
		assert.equal(instant.toISOString(), '2026-09-06T06:30:00.000Z');
		assert.equal(toLocalInputValue(instant, JAKARTA), '2026-09-06T13:30');
	});

	test('the same text means different instants in different zones', () => {
		const jakarta = fromLocalInputValue('2026-09-06T13:00', JAKARTA);
		const newYork = fromLocalInputValue('2026-09-06T13:00', NEW_YORK);
		assert.notEqual(jakarta?.toISOString(), newYork?.toISOString());
	});

	test('rejects text that is not a datetime-local value', () => {
		assert.equal(fromLocalInputValue('', JAKARTA), null);
		assert.equal(fromLocalInputValue('tomorrow', JAKARTA), null);
	});
});

describe('validating a zone name', () => {
	test('accepts IANA names and rejects nonsense', () => {
		assert.equal(isValidTimeZone(JAKARTA), true);
		assert.equal(isValidTimeZone('UTC'), true);
		assert.equal(isValidTimeZone('Mars/Olympus_Mons'), false);
	});
});
