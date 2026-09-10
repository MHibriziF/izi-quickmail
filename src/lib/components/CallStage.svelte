<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import {
		Room,
		RoomEvent,
		Track,
		type Participant,
		type RemoteParticipant,
		type RemoteTrack,
		type RemoteTrackPublication
	} from 'livekit-client';
	import { t } from '$lib/i18n';
	import Icon from '$lib/components/Icon.svelte';

	let {
		url,
		token,
		displayName,
		onleave
	}: { url: string; token: string; displayName: string; onleave: () => void } = $props();

	let room: Room | null = null;
	let localMediaEl = $state<HTMLDivElement>();
	let remoteContainerEl = $state<HTMLDivElement>();
	let connecting = $state(true);
	let connectionError = $state('');
	let micEnabled = $state(true);
	let cameraEnabled = $state(true);
	let remoteCount = $state(0);

	type Tile = { el: HTMLDivElement; media: HTMLDivElement };
	const remoteTiles = new Map<string, Tile>();

	function createTile(label: string): Tile {
		const el = document.createElement('div');
		el.className = 'call-tile';
		const media = document.createElement('div');
		media.className = 'call-tile-media';
		const name = document.createElement('span');
		name.className = 'call-tile-name';
		name.textContent = label;
		el.append(media, name);
		return { el, media };
	}

	function ensureRemoteTile(participant: Participant): Tile {
		let tile = remoteTiles.get(participant.identity);
		if (!tile) {
			tile = createTile(participant.name || t('meet.guest'));
			remoteContainerEl?.appendChild(tile.el);
			remoteTiles.set(participant.identity, tile);
			remoteCount = remoteTiles.size;
		}
		return tile;
	}

	function attachRemoteTrack(
		track: RemoteTrack,
		_publication: RemoteTrackPublication,
		participant: RemoteParticipant
	) {
		if (track.kind !== Track.Kind.Video && track.kind !== Track.Kind.Audio) return;
		const tile = ensureRemoteTile(participant);
		tile.media.appendChild(track.attach());
	}

	function detachRemoteTrack(track: RemoteTrack) {
		for (const el of track.detach()) el.remove();
	}

	function removeParticipantTile(participant: RemoteParticipant) {
		const tile = remoteTiles.get(participant.identity);
		if (!tile) return;
		tile.el.remove();
		remoteTiles.delete(participant.identity);
		remoteCount = remoteTiles.size;
	}

	onMount(() => {
		const instance = new Room();
		room = instance;

		instance.on(RoomEvent.TrackSubscribed, attachRemoteTrack);
		instance.on(RoomEvent.TrackUnsubscribed, detachRemoteTrack);
		instance.on(RoomEvent.ParticipantDisconnected, removeParticipantTile);
		instance.on(RoomEvent.Disconnected, onleave);

		(async () => {
			try {
				await instance.connect(url, token);
				await instance.localParticipant.setMicrophoneEnabled(true);
				const cameraPublication = await instance.localParticipant.setCameraEnabled(true);
				const track = cameraPublication?.track;
				if (track) {
					const el = track.attach();
					el.muted = true;
					localMediaEl?.appendChild(el);
				}
			} catch (error) {
				connectionError = error instanceof Error ? error.message : t('meet.connectionError');
			} finally {
				connecting = false;
			}
		})();

		return () => {
			instance.off(RoomEvent.TrackSubscribed, attachRemoteTrack);
			instance.off(RoomEvent.TrackUnsubscribed, detachRemoteTrack);
			instance.off(RoomEvent.ParticipantDisconnected, removeParticipantTile);
			instance.off(RoomEvent.Disconnected, onleave);
		};
	});

	onDestroy(() => {
		room?.disconnect();
	});

	async function toggleMic() {
		if (!room) return;
		micEnabled = !micEnabled;
		await room.localParticipant.setMicrophoneEnabled(micEnabled);
	}

	async function toggleCamera() {
		if (!room) return;
		cameraEnabled = !cameraEnabled;
		await room.localParticipant.setCameraEnabled(cameraEnabled);
	}

	function leave() {
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

	<div class="call-grid">
		<div class="call-tile call-tile-local">
			<div class="call-tile-media" bind:this={localMediaEl}></div>
			<span class="call-tile-name">{displayName} · {t('meet.you')}</span>
		</div>
		<div class="call-tile-group" bind:this={remoteContainerEl}></div>
		{#if !connecting && !connectionError && remoteCount === 0}
			<div class="call-tile call-tile-placeholder">
				<span>{t('meet.waitingForOthers')}</span>
			</div>
		{/if}
	</div>

	<div class="call-controls">
		<button type="button" class="call-btn" onclick={toggleMic} aria-label={micEnabled ? t('meet.micOn') : t('meet.micOff')}>
			<Icon name={micEnabled ? 'mic-line' : 'mic-off-line'} size={20} />
		</button>
		<button
			type="button"
			class="call-btn"
			onclick={toggleCamera}
			aria-label={cameraEnabled ? t('meet.cameraOn') : t('meet.cameraOff')}
		>
			<Icon name={cameraEnabled ? 'camera-line' : 'camera-off-line'} size={20} />
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

	.call-grid {
		flex: 1;
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
		gap: 0.75rem;
		align-content: start;
	}

	.call-tile {
		position: relative;
		aspect-ratio: 16 / 9;
		width: 100%;
		border-radius: 0.75rem;
		background: #1c1c1f;
		overflow: hidden;
	}

	.call-tile-media {
		width: 100%;
		height: 100%;
	}

	.call-tile-media :global(video) {
		width: 100%;
		height: 100%;
		object-fit: cover;
		display: block;
	}

	.call-tile-name {
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

	.call-tile-placeholder {
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

	.call-controls {
		display: flex;
		justify-content: center;
		gap: 0.75rem;
		padding-bottom: 0.5rem;
	}

	.call-btn {
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

	.call-btn-leave {
		background: #dc2626;
	}

	.call-btn-leave:hover {
		background: #ef4444;
	}
</style>
