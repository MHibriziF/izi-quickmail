<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import {
		Room,
		RoomEvent,
		Track,
		type RemoteParticipant,
		type RemoteTrack,
		type RemoteTrackPublication
	} from 'livekit-client';
	import { t } from '$lib/i18n';
	import Icon from '$lib/components/Icon.svelte';

	let { url, token, onleave }: { url: string; token: string; onleave: () => void } = $props();

	let room: Room | null = null;
	let localVideoEl = $state<HTMLDivElement>();
	let remoteContainerEl = $state<HTMLDivElement>();
	let connecting = $state(true);
	let connectionError = $state('');
	let micEnabled = $state(true);
	let cameraEnabled = $state(true);

	function attachRemoteTrack(
		track: RemoteTrack,
		_publication: RemoteTrackPublication,
		participant: RemoteParticipant
	) {
		if (track.kind !== Track.Kind.Video && track.kind !== Track.Kind.Audio) return;
		const el = track.attach();
		el.dataset.participant = participant.identity;
		remoteContainerEl?.appendChild(el);
	}

	function detachRemoteTrack(track: RemoteTrack) {
		for (const el of track.detach()) el.remove();
	}

	onMount(() => {
		const instance = new Room();
		room = instance;

		instance.on(RoomEvent.TrackSubscribed, attachRemoteTrack);
		instance.on(RoomEvent.TrackUnsubscribed, detachRemoteTrack);
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
					localVideoEl?.appendChild(el);
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
	{#if connecting}
		<p class="call-status">{t('meet.connecting')}</p>
	{:else if connectionError}
		<p class="call-status call-status-error">{connectionError}</p>
	{/if}

	<div class="call-grid">
		<div class="call-tile call-tile-local" bind:this={localVideoEl}></div>
		<div class="call-tile-group" bind:this={remoteContainerEl}></div>
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
		gap: 1rem;
		width: 100%;
		height: 100%;
		min-height: 100dvh;
		padding: 1rem;
		background: #0b0b0d;
		color: #fff;
		box-sizing: border-box;
	}

	.call-status {
		text-align: center;
		font-size: 0.875rem;
		color: rgba(255, 255, 255, 0.7);
	}

	.call-status-error {
		color: #f87171;
	}

	.call-grid {
		flex: 1;
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
		gap: 0.75rem;
		align-content: start;
	}

	.call-tile,
	.call-tile-group :global(video) {
		aspect-ratio: 16 / 9;
		width: 100%;
		border-radius: 0.75rem;
		background: #1c1c1f;
		object-fit: cover;
	}

	.call-tile :global(video) {
		width: 100%;
		height: 100%;
		border-radius: 0.75rem;
		object-fit: cover;
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
