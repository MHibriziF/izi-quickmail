import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { applyDeafenToggle, applyMicToggle, type MicDeafenState } from '../av-state';

const base: MicDeafenState = { micEnabled: true, deafened: false, micEnabledBeforeDeafen: null };

describe('applyMicToggle', () => {
	test('turns the mic off, unrelated to deafen', () => {
		const next = applyMicToggle({ ...base, micEnabled: true });
		assert.deepEqual(next, { micEnabled: false, deafened: false, micEnabledBeforeDeafen: null });
	});

	test('turns the mic on when not deafened', () => {
		const next = applyMicToggle({ ...base, micEnabled: false });
		assert.deepEqual(next, { micEnabled: true, deafened: false, micEnabledBeforeDeafen: null });
	});

	test('turning the mic on while deafened also undeafens', () => {
		const next = applyMicToggle({ micEnabled: false, deafened: true, micEnabledBeforeDeafen: false });
		assert.deepEqual(next, { micEnabled: true, deafened: false, micEnabledBeforeDeafen: null });
	});

	test('clicking mic from the real post-deafen state (mic forced off) undeafens, matching the on-click rule', () => {
		// deafen always leaves micEnabled: false behind (see applyDeafenToggle) — this is the
		// only state clicking mic can realistically start from while deafened.
		const next = applyMicToggle({ micEnabled: false, deafened: true, micEnabledBeforeDeafen: true });
		assert.deepEqual(next, { micEnabled: true, deafened: false, micEnabledBeforeDeafen: null });
	});

	test('a manual mic change clears micEnabledBeforeDeafen so undeafening later does not stomp it', () => {
		const next = applyMicToggle({ micEnabled: false, deafened: false, micEnabledBeforeDeafen: true });
		assert.equal(next.micEnabledBeforeDeafen, null);
	});
});

describe('applyDeafenToggle', () => {
	test('deafening with the mic on force-mutes it and remembers the on state', () => {
		const next = applyDeafenToggle({ micEnabled: true, deafened: false, micEnabledBeforeDeafen: null });
		assert.deepEqual(next, { micEnabled: false, deafened: true, micEnabledBeforeDeafen: true });
	});

	test('deafening with the mic already off remembers the off state', () => {
		const next = applyDeafenToggle({ micEnabled: false, deafened: false, micEnabledBeforeDeafen: null });
		assert.deepEqual(next, { micEnabled: false, deafened: true, micEnabledBeforeDeafen: false });
	});

	test('undeafening restores the remembered mic state (was on)', () => {
		const next = applyDeafenToggle({ micEnabled: false, deafened: true, micEnabledBeforeDeafen: true });
		assert.deepEqual(next, { micEnabled: true, deafened: false, micEnabledBeforeDeafen: null });
	});

	test('undeafening restores the remembered mic state (was off)', () => {
		const next = applyDeafenToggle({ micEnabled: false, deafened: true, micEnabledBeforeDeafen: false });
		assert.deepEqual(next, { micEnabled: false, deafened: false, micEnabledBeforeDeafen: null });
	});

	test('undeafening with nothing remembered leaves the mic alone', () => {
		const next = applyDeafenToggle({ micEnabled: true, deafened: true, micEnabledBeforeDeafen: null });
		assert.deepEqual(next, { micEnabled: true, deafened: false, micEnabledBeforeDeafen: null });
	});

	test('a full deafen/undeafen round trip is a no-op on the mic', () => {
		const deafened = applyDeafenToggle(base);
		const undeafened = applyDeafenToggle(deafened);
		assert.deepEqual(undeafened, base);
	});
});

describe('mic and deafen combined, matching real click sequences', () => {
	test('deafen, then click mic to undeafen, then deafen again starts fresh', () => {
		let state = base; // { micEnabled: true, deafened: false, micEnabledBeforeDeafen: null }

		state = applyDeafenToggle(state);
		assert.deepEqual(state, { micEnabled: false, deafened: true, micEnabledBeforeDeafen: true });

		state = applyMicToggle(state); // clicking mic while deafened
		assert.deepEqual(state, { micEnabled: true, deafened: false, micEnabledBeforeDeafen: null });

		state = applyDeafenToggle(state);
		assert.deepEqual(state, { micEnabled: false, deafened: true, micEnabledBeforeDeafen: true });
	});

	test('muting manually, then deafening, then undeafening leaves the mic muted as it was', () => {
		let state = base;

		state = applyMicToggle(state); // manual mute
		assert.equal(state.micEnabled, false);

		state = applyDeafenToggle(state); // deafen while already muted
		assert.deepEqual(state, { micEnabled: false, deafened: true, micEnabledBeforeDeafen: false });

		state = applyDeafenToggle(state); // undeafen
		assert.deepEqual(state, { micEnabled: false, deafened: false, micEnabledBeforeDeafen: null });
	});
});
