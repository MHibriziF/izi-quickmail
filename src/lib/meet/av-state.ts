/**
 * Pure mic/deafen state transitions, shared by the lobby (before a room
 * exists) and CallStage (once connected) — both wrap this with their own
 * side effects (actually muting the track, playing a tone, syncing the
 * `deafened` attribute), but the *rules* for how mic and deafen affect each
 * other live here, in one testable place, instead of being duplicated and
 * drifting between the two callers.
 */
export type MicDeafenState = {
	micEnabled: boolean;
	deafened: boolean;
	/** The mic's on/off value from just before deafen was turned on, restored when it's turned off; `null` when not currently deafened (or after a manual mic change has superseded it). */
	micEnabledBeforeDeafen: boolean | null;
};

/**
 * Turning the mic on while deafened means "I want to be heard again" — undeafen too, so you can
 * actually hear the conversation you just started talking in. Any other manual mic change clears
 * `micEnabledBeforeDeafen`, since the user's explicit choice should win over what deafen was
 * planning to restore later.
 */
export function applyMicToggle(state: MicDeafenState): MicDeafenState {
	const micEnabled = !state.micEnabled;
	if (micEnabled && state.deafened) {
		return { micEnabled, deafened: false, micEnabledBeforeDeafen: null };
	}
	return { micEnabled, deafened: state.deafened, micEnabledBeforeDeafen: null };
}

/**
 * Turning deafen on force-mutes the mic (remembering whatever it was so it can be restored) —
 * you can't hear yourself asked a question you can't hear. Turning it off restores that
 * remembered value, or leaves the mic alone if there was nothing to restore (e.g. deafen was
 * toggled on/off without ever having been on in this session — shouldn't normally happen, but
 * falling back to leaving the mic as-is is safer than guessing).
 */
export function applyDeafenToggle(state: MicDeafenState): MicDeafenState {
	const deafened = !state.deafened;
	if (deafened) {
		return { deafened, micEnabled: false, micEnabledBeforeDeafen: state.micEnabled };
	}
	if (state.micEnabledBeforeDeafen !== null) {
		return { deafened, micEnabled: state.micEnabledBeforeDeafen, micEnabledBeforeDeafen: null };
	}
	return { deafened, micEnabled: state.micEnabled, micEnabledBeforeDeafen: null };
}
