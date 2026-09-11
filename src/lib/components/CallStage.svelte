<script lang="ts">
	import { onDestroy, onMount, tick, untrack } from 'svelte';
	import {
		Room,
		RoomEvent,
		Track,
		type LocalTrackPublication,
		type Participant,
		type RemoteParticipant,
		type RemoteTrack,
		type RemoteTrackPublication,
		type TrackPublication
	} from 'livekit-client';
	import { t } from '$lib/i18n';
	import Icon from '$lib/components/Icon.svelte';
	import DeviceSelect from '$lib/components/DeviceSelect.svelte';

	let {
		url,
		token,
		displayName,
		initialMicEnabled = true,
		initialCameraEnabled = true,
		initialMicDeviceId = '',
		initialCameraDeviceId = '',
		onleave
	}: {
		url: string;
		token: string;
		displayName: string;
		initialMicEnabled?: boolean;
		initialCameraEnabled?: boolean;
		initialMicDeviceId?: string;
		initialCameraDeviceId?: string;
		onleave: () => void;
	} = $props();

	// getDisplayMedia has no mobile browser support (iOS/WebKit or Chrome
	// Android) as of 2026 — hide the control rather than fail silently on tap.
	const screenShareSupported =
		typeof navigator !== 'undefined' && typeof navigator.mediaDevices?.getDisplayMedia === 'function';

	// setSinkId (routing audio to a chosen output device) is unsupported in
	// Safari as of 2026 — hide the speaker picker there rather than fail on tap.
	const speakerSelectionSupported =
		typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype;

	const CHAT_TOPIC = 'chat';

	let room: Room | null = null;
	let localMediaEl = $state<HTMLDivElement>();
	let remoteContainerEl = $state<HTMLDivElement>();
	let connecting = $state(true);
	let connectionError = $state('');
	let micEnabled = $state(untrack(() => initialMicEnabled));
	let cameraEnabled = $state(untrack(() => initialCameraEnabled));
	let micDeviceId = $state(untrack(() => initialMicDeviceId));
	let cameraDeviceId = $state(untrack(() => initialCameraDeviceId));
	let speakerDeviceId = $state('');
	let screenShareEnabled = $state(false);
	let remoteCount = $state(0);
	let localScreenMediaEl = $state<HTMLDivElement>();

	let panel = $state<'none' | 'participants' | 'chat'>('none');
	let roster = $state<{ identity: string; name: string; isLocal: boolean }[]>([]);
	let messages = $state<{ id: string; from: string; text: string; isLocal: boolean }[]>([]);
	let unread = $state(0);
	let chatInput = $state('');
	let chatBodyEl = $state<HTMLDivElement>();

	function initialsFor(name: string): string {
		return (
			name
				.trim()
				.split(/\s+/)
				.filter(Boolean)
				.slice(0, 2)
				.map((part) => part[0]!.toUpperCase())
				.join('') || '?'
		);
	}

	/** A stable color per identity, so returning to a tile always looks the same. */
	function colorFor(seed: string): string {
		let hash = 0;
		for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) | 0;
		return `hsl(${Math.abs(hash) % 360}, 45%, 38%)`;
	}

	const localInitials = $derived(initialsFor(displayName));
	const localColor = $derived(colorFor(displayName || 'me'));

	// A short beep synthesized on the fly — no audio asset to ship, and it works
	// the instant a call starts instead of waiting on a file to load.
	let soundCtx: AudioContext | null = null;

	function ensureSoundCtx(): AudioContext {
		if (!soundCtx) soundCtx = new AudioContext();
		if (soundCtx.state === 'suspended') void soundCtx.resume();
		return soundCtx;
	}

	function playTone(frequency: number, startOffset: number, duration = 0.09) {
		const ctx = ensureSoundCtx();
		const start = ctx.currentTime + startOffset;
		const oscillator = ctx.createOscillator();
		const gain = ctx.createGain();
		oscillator.frequency.value = frequency;
		gain.gain.setValueAtTime(0, start);
		gain.gain.linearRampToValueAtTime(0.2, start + 0.01);
		gain.gain.linearRampToValueAtTime(0, start + duration);
		oscillator.connect(gain);
		gain.connect(ctx.destination);
		oscillator.start(start);
		oscillator.stop(start + duration + 0.02);
	}

	function playJoinChime() {
		playTone(523.25, 0);
		playTone(659.25, 0.09);
	}

	function playLeaveChime() {
		playTone(659.25, 0);
		playTone(523.25, 0.09);
	}

	function playToggleTone(on: boolean) {
		playTone(on ? 880 : 440, 0, 0.08);
	}

	type Tile = { el: HTMLDivElement; media: HTMLDivElement; micIcon: HTMLElement; cameraIcon: HTMLElement };
	const remoteTiles = new Map<string, Tile>();
	const screenTiles = new Map<string, Tile>();

	function createTile(identity: string, label: string, extraClass = ''): Tile {
		const el = document.createElement('div');
		el.className = extraClass ? `call-tile ${extraClass}` : 'call-tile';

		const avatar = document.createElement('div');
		avatar.className = 'call-tile-avatar';
		avatar.style.background = colorFor(identity);
		avatar.textContent = initialsFor(label);

		const media = document.createElement('div');
		media.className = 'call-tile-media';

		const status = document.createElement('div');
		status.className = 'call-tile-status';
		const micIcon = document.createElement('i');
		micIcon.className = 'ri-mic-off-line call-tile-status-icon';
		micIcon.hidden = true;
		const cameraIcon = document.createElement('i');
		cameraIcon.className = 'ri-camera-off-line call-tile-status-icon';
		cameraIcon.hidden = true;
		status.append(micIcon, cameraIcon);

		const name = document.createElement('span');
		name.className = 'call-tile-name';
		name.textContent = label;

		el.append(avatar, media, status, name);
		return { el, media, micIcon, cameraIcon };
	}

	/** Reflects a participant's current mute state on their tile's status badges. */
	function updateTileStatus(tile: Tile, participant: Participant) {
		tile.micIcon.hidden = participant.isMicrophoneEnabled;
		tile.cameraIcon.hidden = participant.isCameraEnabled;
	}

	function ensureRemoteTile(participant: Participant): Tile {
		let tile = remoteTiles.get(participant.identity);
		if (!tile) {
			tile = createTile(participant.identity, participant.name || t('meet.guest'));
			remoteContainerEl?.appendChild(tile.el);
			remoteTiles.set(participant.identity, tile);
			remoteCount = remoteTiles.size;
		}
		updateTileStatus(tile, participant);
		return tile;
	}

	function handleTrackMuteChanged(_publication: TrackPublication, participant: Participant) {
		const tile = remoteTiles.get(participant.identity);
		if (tile) updateTileStatus(tile, participant);
	}

	function ensureScreenTile(participant: Participant): Tile {
		let tile = screenTiles.get(participant.identity);
		if (!tile) {
			tile = createTile(participant.identity, t('meet.screenShareOf', { name: participant.name || t('meet.guest') }), 'call-tile-screen');
			remoteContainerEl?.appendChild(tile.el);
			screenTiles.set(participant.identity, tile);
		}
		return tile;
	}

	function removeScreenTile(identity: string) {
		const tile = screenTiles.get(identity);
		if (tile) {
			tile.el.remove();
			screenTiles.delete(identity);
		}
	}

	/** Routes one attached remote element to the chosen output device, if a non-default one is picked. */
	function applySinkId(el: HTMLMediaElement) {
		if (!speakerSelectionSupported || !speakerDeviceId) return;
		void (el as HTMLMediaElement & { setSinkId(id: string): Promise<void> }).setSinkId(speakerDeviceId).catch(() => {
			// Device may have disappeared since selection — the default output still plays.
		});
	}

	function attachRemoteTrack(
		track: RemoteTrack,
		_publication: RemoteTrackPublication,
		participant: RemoteParticipant
	) {
		if (track.kind !== Track.Kind.Video && track.kind !== Track.Kind.Audio) return;
		if (track.source === Track.Source.ScreenShare || track.source === Track.Source.ScreenShareAudio) {
			const tile = ensureScreenTile(participant);
			const el = track.attach();
			applySinkId(el);
			tile.media.appendChild(el);
			return;
		}
		const tile = ensureRemoteTile(participant);
		const el = track.attach();
		applySinkId(el);
		tile.media.appendChild(el);
	}

	function detachRemoteTrack(
		track: RemoteTrack,
		_publication: RemoteTrackPublication,
		participant: RemoteParticipant
	) {
		// The avatar layer sits behind the media layer, so emptying it (camera
		// off, or a full unpublish) is all it takes for the avatar to show again.
		for (const el of track.detach()) el.remove();
		// The screen tile has no avatar fallback, so it only makes sense while sharing.
		if (track.source === Track.Source.ScreenShare) removeScreenTile(participant.identity);
	}

	function handleParticipantConnected(participant: RemoteParticipant) {
		playJoinChime();
		ensureRemoteTile(participant);
		refreshRoster();
	}

	function removeParticipantTile(participant: RemoteParticipant) {
		playLeaveChime();
		const tile = remoteTiles.get(participant.identity);
		if (tile) {
			tile.el.remove();
			remoteTiles.delete(participant.identity);
			remoteCount = remoteTiles.size;
		}
		removeScreenTile(participant.identity);
		refreshRoster();
	}

	function refreshRoster() {
		if (!room) return;
		const remote = Array.from(room.remoteParticipants.values()).map((p) => ({
			identity: p.identity,
			name: p.name || t('meet.guest'),
			isLocal: false
		}));
		roster = [{ identity: room.localParticipant.identity, name: displayName, isLocal: true }, ...remote];
	}

	async function scrollChatToEnd() {
		await tick();
		chatBodyEl?.scrollTo({ top: chatBodyEl.scrollHeight });
	}

	function receiveChatMessage(text: string, identity: string) {
		const from = roster.find((p) => p.identity === identity)?.name || t('meet.guest');
		messages = [...messages, { id: crypto.randomUUID(), from, text, isLocal: false }];
		if (panel !== 'chat') unread += 1;
		void scrollChatToEnd();
	}

	function handleLocalTrackPublished(publication: LocalTrackPublication) {
		if (publication.source !== Track.Source.ScreenShare || !publication.track) return;
		screenShareEnabled = true;
		const el = publication.track.attach();
		localScreenMediaEl?.appendChild(el);
	}

	function handleLocalTrackUnpublished(publication: LocalTrackPublication) {
		if (publication.source !== Track.Source.ScreenShare) return;
		screenShareEnabled = false;
		if (localScreenMediaEl) localScreenMediaEl.innerHTML = '';
	}

	onMount(() => {
		const instance = new Room();
		room = instance;

		instance.on(RoomEvent.TrackSubscribed, attachRemoteTrack);
		instance.on(RoomEvent.TrackUnsubscribed, detachRemoteTrack);
		instance.on(RoomEvent.ParticipantConnected, handleParticipantConnected);
		instance.on(RoomEvent.ParticipantDisconnected, removeParticipantTile);
		instance.on(RoomEvent.Disconnected, onleave);
		instance.on(RoomEvent.LocalTrackPublished, handleLocalTrackPublished);
		instance.on(RoomEvent.LocalTrackUnpublished, handleLocalTrackUnpublished);
		instance.on(RoomEvent.TrackMuted, handleTrackMuteChanged);
		instance.on(RoomEvent.TrackUnmuted, handleTrackMuteChanged);

		instance.registerTextStreamHandler(CHAT_TOPIC, async (reader, participantInfo) => {
			const text = await reader.readAll();
			receiveChatMessage(text, participantInfo.identity);
		});

		(async () => {
			try {
				await instance.connect(url, token);
				await instance.localParticipant.setMicrophoneEnabled(
					micEnabled,
					micDeviceId ? { deviceId: micDeviceId } : undefined
				);
				const cameraPublication = await instance.localParticipant.setCameraEnabled(
					cameraEnabled,
					cameraDeviceId ? { deviceId: cameraDeviceId } : undefined
				);
				const track = cameraPublication?.track;
				if (track) {
					const el = track.attach();
					el.muted = true;
					el.style.transform = 'scaleX(-1)';
					localMediaEl?.appendChild(el);
				}
				for (const participant of instance.remoteParticipants.values()) ensureRemoteTile(participant);
				refreshRoster();
				playJoinChime();
			} catch (error) {
				connectionError = error instanceof Error ? error.message : t('meet.connectionError');
			} finally {
				connecting = false;
			}
		})();

		return () => {
			instance.off(RoomEvent.TrackSubscribed, attachRemoteTrack);
			instance.off(RoomEvent.TrackUnsubscribed, detachRemoteTrack);
			instance.off(RoomEvent.ParticipantConnected, handleParticipantConnected);
			instance.off(RoomEvent.ParticipantDisconnected, removeParticipantTile);
			instance.off(RoomEvent.Disconnected, onleave);
			instance.off(RoomEvent.LocalTrackPublished, handleLocalTrackPublished);
			instance.off(RoomEvent.LocalTrackUnpublished, handleLocalTrackUnpublished);
			instance.off(RoomEvent.TrackMuted, handleTrackMuteChanged);
			instance.off(RoomEvent.TrackUnmuted, handleTrackMuteChanged);
			instance.unregisterTextStreamHandler(CHAT_TOPIC);
		};
	});

	onDestroy(() => {
		room?.disconnect();
		// Give the leave chime time to finish before the context that plays it dies.
		if (soundCtx) {
			const ctx = soundCtx;
			setTimeout(() => void ctx.close(), 300);
		}
	});

	async function toggleMic() {
		if (!room) return;
		micEnabled = !micEnabled;
		playToggleTone(micEnabled);
		await room.localParticipant.setMicrophoneEnabled(micEnabled);
	}

	async function toggleCamera() {
		if (!room) return;
		cameraEnabled = !cameraEnabled;
		playToggleTone(cameraEnabled);
		if (cameraEnabled) {
			const publication = await room.localParticipant.setCameraEnabled(
				true,
				cameraDeviceId ? { deviceId: cameraDeviceId } : undefined
			);
			const track = publication?.track;
			if (track && localMediaEl) {
				localMediaEl.innerHTML = '';
				const el = track.attach();
				el.muted = true;
				el.style.transform = 'scaleX(-1)';
				localMediaEl.appendChild(el);
			}
		} else {
			await room.localParticipant.setCameraEnabled(false);
			if (localMediaEl) localMediaEl.innerHTML = '';
		}
	}

	async function selectMic(id: string) {
		micDeviceId = id;
		if (room) await room.switchActiveDevice('audioinput', id);
	}

	async function selectCamera(id: string) {
		cameraDeviceId = id;
		if (room) await room.switchActiveDevice('videoinput', id);
	}

	function selectSpeaker(id: string) {
		speakerDeviceId = id;
		if (!room) return;
		for (const participant of room.remoteParticipants.values()) {
			for (const publication of [...participant.audioTrackPublications.values(), ...participant.videoTrackPublications.values()]) {
				for (const el of publication.track?.attachedElements ?? []) applySinkId(el);
			}
		}
	}

	async function toggleScreenShare() {
		if (!room) return;
		try {
			// LiveKit shows the browser's own screen/window picker and, if the user
			// cancels it, rejects here without ever publishing — nothing to undo.
			await room.localParticipant.setScreenShareEnabled(!screenShareEnabled, { audio: true });
		} catch {
			// Picker dismissed or permission denied; state already reflects "off".
		}
	}

	function togglePanel(next: 'participants' | 'chat') {
		panel = panel === next ? 'none' : next;
		if (panel === 'chat') {
			unread = 0;
			void scrollChatToEnd();
		}
	}

	async function sendChatMessage(event: SubmitEvent) {
		event.preventDefault();
		const text = chatInput.trim();
		if (!text || !room) return;
		chatInput = '';
		messages = [...messages, { id: crypto.randomUUID(), from: displayName, text, isLocal: true }];
		void scrollChatToEnd();
		try {
			await room.localParticipant.sendText(text, { topic: CHAT_TOPIC });
		} catch {
			// The message still shows locally; a dropped send isn't worth blocking the call over.
		}
	}

	function leave() {
		playLeaveChime();
		room?.disconnect();
		onleave();
	}
</script>

<div class="call-stage">
	<div class="call-header">
		<span class="call-header-name">{displayName}</span>
		{#if connecting}
			<span class="call-header-status">{t('meet.connecting')}</span>
		{:else if connectionError}
			<span class="call-header-status call-header-status-error">{connectionError}</span>
		{/if}
	</div>

	<div class="call-body">
		<div class="call-grid">
			<div class="call-tile call-tile-screen" hidden={!screenShareEnabled}>
				<div class="call-tile-media" bind:this={localScreenMediaEl}></div>
				<span class="call-tile-name">{t('meet.you')} · {t('meet.screenShare')}</span>
			</div>
			<div class="call-tile call-tile-local">
				<div class="call-tile-avatar" style="background: {localColor}">{localInitials}</div>
				<div class="call-tile-media" bind:this={localMediaEl}></div>
				<div class="call-tile-status">
					{#if !micEnabled}<Icon name="mic-off-line" size={14} class="call-tile-status-icon" />{/if}
					{#if !cameraEnabled}<Icon name="camera-off-line" size={14} class="call-tile-status-icon" />{/if}
				</div>
				<span class="call-tile-name">{displayName} · {t('meet.you')}</span>
			</div>
			<div class="call-tile-group" bind:this={remoteContainerEl}></div>
			{#if !connecting && !connectionError && remoteCount === 0}
				<div class="call-tile call-tile-placeholder">
					<span>{t('meet.waitingForOthers')}</span>
				</div>
			{/if}
		</div>

		{#if panel === 'participants'}
			<div class="call-panel">
				<div class="call-panel-head">
					<strong>{t('meet.participants')} ({roster.length})</strong>
					<button type="button" class="call-panel-close" onclick={() => (panel = 'none')} aria-label={t('meet.close')}>
						<Icon name="close-line" size={18} />
					</button>
				</div>
				<ul class="call-panel-list">
					{#each roster as person (person.identity)}
						<li class="call-participant-row">
							<span class="call-participant-avatar" style="background: {colorFor(person.identity)}">
								{initialsFor(person.name)}
							</span>
							<span>{person.name}{person.isLocal ? ` · ${t('meet.you')}` : ''}</span>
						</li>
					{/each}
				</ul>
			</div>
		{:else if panel === 'chat'}
			<div class="call-panel">
				<div class="call-panel-head">
					<strong>{t('meet.chat')}</strong>
					<button type="button" class="call-panel-close" onclick={() => (panel = 'none')} aria-label={t('meet.close')}>
						<Icon name="close-line" size={18} />
					</button>
				</div>
				<div class="call-chat-body" bind:this={chatBodyEl}>
					{#if messages.length === 0}
						<p class="call-chat-empty">{t('meet.noMessages')}</p>
					{:else}
						{#each messages as message (message.id)}
							<div class="call-chat-message" class:own={message.isLocal}>
								{#if !message.isLocal}<span class="call-chat-from">{message.from}</span>{/if}
								<span class="call-chat-text">{message.text}</span>
							</div>
						{/each}
					{/if}
				</div>
				<form class="call-chat-form" onsubmit={sendChatMessage}>
					<input
						class="call-chat-input"
						type="text"
						bind:value={chatInput}
						maxlength={500}
						placeholder={t('meet.chatPlaceholder')}
					/>
					<button type="submit" class="call-chat-send" disabled={!chatInput.trim()}>{t('meet.send')}</button>
				</form>
			</div>
		{/if}
	</div>

	<div class="call-controls">
		<div class="call-btn-pill" class:call-btn-pill-off={!micEnabled}>
			<DeviceSelect kind="audioinput" deviceId={micDeviceId} label={t('meet.chooseMic')} onselect={selectMic} menuAlign="start" />
			<button
				type="button"
				class="call-btn-pill-main"
				onclick={toggleMic}
				aria-label={micEnabled ? t('meet.micOn') : t('meet.micOff')}
			>
				<Icon name={micEnabled ? 'mic-line' : 'mic-off-line'} size={20} />
			</button>
		</div>
		<div class="call-btn-pill" class:call-btn-pill-off={!cameraEnabled}>
			<DeviceSelect kind="videoinput" deviceId={cameraDeviceId} label={t('meet.chooseCamera')} onselect={selectCamera} menuAlign="start" />
			<button
				type="button"
				class="call-btn-pill-main"
				onclick={toggleCamera}
				aria-label={cameraEnabled ? t('meet.cameraOn') : t('meet.cameraOff')}
			>
				<Icon name={cameraEnabled ? 'camera-line' : 'camera-off-line'} size={20} />
			</button>
		</div>
		{#if speakerSelectionSupported}
			<DeviceSelect
				kind="audiooutput"
				deviceId={speakerDeviceId}
				label={t('meet.chooseSpeaker')}
				onselect={selectSpeaker}
				menuAlign="start"
				standalone
				icon="volume-up-line"
			/>
		{/if}
		{#if screenShareSupported}
			<button
				type="button"
				class="call-btn"
				class:call-btn-active={screenShareEnabled}
				onclick={toggleScreenShare}
				aria-label={screenShareEnabled ? t('meet.screenShareOff') : t('meet.screenShareOn')}
			>
				<Icon name="computer-line" size={20} />
			</button>
		{/if}
		<button
			type="button"
			class="call-btn"
			class:call-btn-active={panel === 'participants'}
			onclick={() => togglePanel('participants')}
			aria-label={t('meet.participants')}
		>
			<Icon name="group-line" size={20} />
			{#if roster.length > 0}<span class="call-btn-badge">{roster.length}</span>{/if}
		</button>
		<button
			type="button"
			class="call-btn"
			class:call-btn-active={panel === 'chat'}
			onclick={() => togglePanel('chat')}
			aria-label={t('meet.chat')}
		>
			<Icon name="chat-3-line" size={20} />
			{#if unread > 0}<span class="call-btn-badge call-btn-badge-alert">{unread}</span>{/if}
		</button>
		<button type="button" class="call-btn call-btn-leave" onclick={leave} aria-label={t('meet.leave')}>
			<Icon name="phone-line" size={20} />
		</button>
	</div>
</div>

<style>
	.call-stage {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		width: 100%;
		height: 100%;
		min-height: 100dvh;
		padding: 1rem;
		background: #0b0b0d;
		color: #fff;
		box-sizing: border-box;
	}

	.call-header {
		display: flex;
		align-items: baseline;
		gap: 0.75rem;
		padding: 0 0.25rem;
	}

	.call-header-name {
		font-size: 0.9rem;
		font-weight: 600;
	}

	.call-header-status {
		font-size: 0.8125rem;
		color: rgba(255, 255, 255, 0.6);
	}

	.call-header-status-error {
		color: #f87171;
	}

	.call-body {
		flex: 1;
		display: flex;
		gap: 0.75rem;
		min-height: 0;
	}

	.call-grid {
		flex: 1;
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
		gap: 0.75rem;
		align-content: start;
		min-width: 0;
	}

	/*
	 * Remote tiles are created with document.createElement, not written in this
	 * component's template — Svelte never sees them, so it never tags them with
	 * its scoping class. Every rule a tile needs must be :global() or it silently
	 * no-ops on remote participants (a mobile camera's portrait video then renders
	 * at its native size with nothing constraining it).
	 */
	:global(.call-tile) {
		position: relative;
		aspect-ratio: 16 / 9;
		width: 100%;
		border-radius: 0.75rem;
		background: #1c1c1f;
		overflow: hidden;
	}

	:global(.call-tile-avatar) {
		position: absolute;
		inset: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		font-size: 1.5rem;
		font-weight: 600;
		color: rgba(255, 255, 255, 0.9);
	}

	:global(.call-tile-media) {
		position: relative;
		width: 100%;
		height: 100%;
	}

	:global(.call-tile-media video) {
		width: 100%;
		height: 100%;
		object-fit: cover;
		display: block;
	}

	:global(.call-tile-name) {
		position: absolute;
		left: 0.5rem;
		bottom: 0.5rem;
		padding: 0.125rem 0.5rem;
		font-size: 0.75rem;
		border-radius: 999px;
		background: rgba(0, 0, 0, 0.55);
		color: #fff;
		max-width: calc(100% - 1rem);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	:global(.call-tile-screen) {
		grid-column: 1 / -1;
		aspect-ratio: 16 / 9;
		max-height: 65vh;
		background: #000;
	}

	:global(.call-tile-screen .call-tile-media video) {
		object-fit: contain;
	}

	:global(.call-tile-status) {
		position: absolute;
		top: 0.5rem;
		right: 0.5rem;
		display: flex;
		gap: 0.25rem;
	}

	:global(.call-tile-status-icon) {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 1.5rem;
		height: 1.5rem;
		border-radius: 999px;
		background: rgba(0, 0, 0, 0.55);
		color: #f87171;
	}

	:global(.call-tile-placeholder) {
		display: flex;
		align-items: center;
		justify-content: center;
		text-align: center;
		padding: 1rem;
		font-size: 0.8125rem;
		color: rgba(255, 255, 255, 0.5);
		border: 1px dashed rgba(255, 255, 255, 0.15);
		background: transparent;
	}

	.call-tile-group {
		display: contents;
	}

	.call-panel {
		display: flex;
		flex-direction: column;
		width: 300px;
		flex-shrink: 0;
		border-radius: 0.75rem;
		background: #17171a;
		overflow: hidden;
	}

	.call-panel-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 0.75rem 1rem;
		border-bottom: 1px solid rgba(255, 255, 255, 0.08);
		font-size: 0.875rem;
	}

	.call-panel-close {
		display: flex;
		border: none;
		background: transparent;
		color: rgba(255, 255, 255, 0.7);
		cursor: pointer;
	}

	.call-panel-list {
		flex: 1;
		list-style: none;
		margin: 0;
		padding: 0.5rem;
		overflow-y: auto;
	}

	.call-participant-row {
		display: flex;
		align-items: center;
		gap: 0.625rem;
		padding: 0.5rem 0.5rem;
		font-size: 0.8125rem;
		border-radius: 0.5rem;
	}

	.call-participant-avatar {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 1.75rem;
		height: 1.75rem;
		border-radius: 999px;
		font-size: 0.6875rem;
		font-weight: 600;
		flex-shrink: 0;
	}

	.call-chat-body {
		flex: 1;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		padding: 0.75rem;
		overflow-y: auto;
	}

	.call-chat-empty {
		margin: auto;
		font-size: 0.8125rem;
		color: rgba(255, 255, 255, 0.5);
	}

	.call-chat-message {
		display: flex;
		flex-direction: column;
		gap: 0.125rem;
		max-width: 85%;
		padding: 0.375rem 0.625rem;
		border-radius: 0.75rem;
		background: rgba(255, 255, 255, 0.08);
		font-size: 0.8125rem;
		align-self: flex-start;
		word-break: break-word;
	}

	.call-chat-message.own {
		align-self: flex-end;
		background: var(--color-accent, #3b82f6);
	}

	.call-chat-from {
		font-size: 0.6875rem;
		font-weight: 600;
		color: rgba(255, 255, 255, 0.6);
	}

	.call-chat-form {
		display: flex;
		gap: 0.5rem;
		padding: 0.75rem;
		border-top: 1px solid rgba(255, 255, 255, 0.08);
	}

	.call-chat-input {
		flex: 1;
		min-width: 0;
		padding: 0.5rem 0.625rem;
		font-size: 0.8125rem;
		border: 1px solid rgba(255, 255, 255, 0.15);
		border-radius: 0.5rem;
		background: rgba(255, 255, 255, 0.06);
		color: #fff;
	}

	.call-chat-send {
		flex-shrink: 0;
		padding: 0.5rem 0.875rem;
		font-size: 0.8125rem;
		font-weight: 500;
		border: none;
		border-radius: 0.5rem;
		background: #26262b;
		color: #fff;
		cursor: pointer;
	}

	.call-chat-send:disabled {
		opacity: 0.5;
		cursor: default;
	}

	.call-controls {
		display: flex;
		justify-content: center;
		gap: 0.75rem;
		padding-bottom: 0.5rem;
	}

	/*
	 * One pill made of two adjacent segments — the device-picker chevron and
	 * the main toggle each paint their own background and their own outer
	 * corner, rather than the pill clipping them with overflow:hidden, which
	 * would also clip the chevron's dropdown menu (it opens outside this box).
	 */
	.call-btn-pill {
		display: flex;
		align-items: stretch;
		height: 48px;
		/* Main segment matches the other round buttons in this bar (screen
		   share, participants, chat); the chevron is secondary, so it sits
		   darker rather than blending into the main segment. */
		--seg-main-bg: #26262b;
		--seg-main-bg-hover: #2c2c31;
		--device-select-bg: #18181b;
		--device-select-bg-hover: #202024;
	}

	.call-btn-pill-off {
		--seg-main-bg: #dc2626;
		--seg-main-bg-hover: #ef4444;
		--device-select-bg: #7f1d1d;
		--device-select-bg-hover: #932222;
	}

	.call-btn-pill-main {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 48px;
		border: none;
		border-radius: 0 999px 999px 0;
		background: var(--seg-main-bg);
		color: #fff;
		cursor: pointer;
	}

	.call-btn-pill-main:hover {
		background: var(--seg-main-bg-hover);
	}

	.call-btn {
		position: relative;
		display: flex;
		align-items: center;
		justify-content: center;
		width: 48px;
		height: 48px;
		border: none;
		border-radius: 999px;
		background: #26262b;
		color: #fff;
		cursor: pointer;
	}

	.call-btn:hover {
		background: #34343a;
	}

	.call-btn-active {
		background: #3f3f46;
		box-shadow: inset 0 0 0 2px rgba(255, 255, 255, 0.3);
	}

	.call-btn-badge {
		position: absolute;
		top: -2px;
		right: -2px;
		display: flex;
		align-items: center;
		justify-content: center;
		min-width: 1.1rem;
		height: 1.1rem;
		padding: 0 0.25rem;
		border-radius: 999px;
		background: #52525b;
		font-size: 0.625rem;
		font-weight: 600;
	}

	.call-btn-badge-alert {
		background: #dc2626;
	}

	.call-btn-leave {
		background: #dc2626;
	}

	.call-btn-leave:hover {
		background: #ef4444;
	}

	@media (max-width: 640px) {
		.call-body {
			flex-direction: column;
		}

		.call-panel {
			width: 100%;
			max-height: 45vh;
		}
	}
</style>
