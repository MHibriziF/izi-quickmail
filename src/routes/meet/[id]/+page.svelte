<script lang="ts">
	import { onMount } from 'svelte';
	import { t } from '$lib/i18n';
	import Logo from '$lib/components/Logo.svelte';
	import Icon from '$lib/components/Icon.svelte';
	import CallStage from '$lib/components/CallStage.svelte';
	import DeviceSelect from '$lib/components/DeviceSelect.svelte';
	import { APP_NAME } from '$lib/constants';
	import { initials } from '$lib/mail/folders';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	let name = $state(data.userName ?? '');
	let joining = $state(false);
	let error = $state('');
	let session = $state<{ url: string; token: string; displayName: string } | null>(null);
	let left = $state(false);

	// Local device check before joining — lets people fix a muted mic or a
	// covered camera instead of discovering it once everyone can already see them.
	let previewStream: MediaStream | null = null;
	let previewVideoEl = $state<HTMLVideoElement>();
	let micOn = $state(true);
	let cameraOn = $state(true);
	let micDeviceId = $state('');
	let cameraDeviceId = $state('');
	let micLevel = $state(0);
	let deviceError = $state('');

	let audioCtx: AudioContext | null = null;
	let analyser: AnalyserNode | null = null;
	let levelFrame = 0;

	const previewInitials = $derived(initials(name || t('meet.guest')));

	onMount(() => {
		void startPreview();
		return stopPreview;
	});

	function attachPreview(stream: MediaStream) {
		previewStream = stream;
		if (previewVideoEl) previewVideoEl.srcObject = stream;
		if (stream.getAudioTracks().length > 0) startLevelMeter(stream);
	}

	async function startPreview() {
		try {
			attachPreview(await navigator.mediaDevices.getUserMedia({ video: true, audio: true }));
			return;
		} catch {
			// Fall through — camera and mic may need to be requested separately
			// when only one of them is actually available or permitted.
		}
		try {
			cameraOn = true;
			micOn = false;
			attachPreview(await navigator.mediaDevices.getUserMedia({ video: true }));
			return;
		} catch {
			cameraOn = false;
		}
		try {
			micOn = true;
			attachPreview(await navigator.mediaDevices.getUserMedia({ audio: true }));
		} catch {
			micOn = false;
			deviceError = t('meet.deviceError');
		}
	}

	function stopPreview() {
		cancelAnimationFrame(levelFrame);
		analyser = null;
		audioCtx?.close();
		audioCtx = null;
		previewStream?.getTracks().forEach((track) => track.stop());
		previewStream = null;
	}

	function startLevelMeter(stream: MediaStream) {
		audioCtx = new AudioContext();
		const source = audioCtx.createMediaStreamSource(stream);
		analyser = audioCtx.createAnalyser();
		analyser.fftSize = 256;
		source.connect(analyser);
		const data = new Uint8Array(analyser.frequencyBinCount);
		const loop = () => {
			if (!analyser) return;
			analyser.getByteFrequencyData(data);
			const average = data.reduce((sum, value) => sum + value, 0) / data.length;
			micLevel = Math.min(1, average / 128);
			levelFrame = requestAnimationFrame(loop);
		};
		loop();
	}

	function toggleMic() {
		micOn = !micOn;
		previewStream?.getAudioTracks().forEach((track) => (track.enabled = micOn));
	}

	function toggleCamera() {
		cameraOn = !cameraOn;
		previewStream?.getVideoTracks().forEach((track) => (track.enabled = cameraOn));
	}

	/** Re-requests both devices so the picked one actually takes effect in the preview. */
	async function applyDeviceSelection() {
		try {
			const stream = await navigator.mediaDevices.getUserMedia({
				video: cameraDeviceId ? { deviceId: { exact: cameraDeviceId } } : true,
				audio: micDeviceId ? { deviceId: { exact: micDeviceId } } : true
			});
			stopPreview();
			attachPreview(stream);
			stream.getAudioTracks().forEach((track) => (track.enabled = micOn));
			stream.getVideoTracks().forEach((track) => (track.enabled = cameraOn));
		} catch {
			deviceError = t('meet.deviceError');
		}
	}

	function selectMic(id: string) {
		micDeviceId = id;
		void applyDeviceSelection();
	}

	function selectCamera(id: string) {
		cameraDeviceId = id;
		void applyDeviceSelection();
	}

	async function join(event: SubmitEvent) {
		event.preventDefault();
		if (joining) return;
		joining = true;
		error = '';

		const displayName = name.trim() || t('meet.guest');

		try {
			const response = await fetch(`/api/meetings/join/${encodeURIComponent(data.id)}`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ token: data.token, name: displayName })
			});
			const body = (await response.json().catch(() => ({}))) as {
				url?: string;
				token?: string;
				error?: string;
			};
			if (!response.ok || !body.url || !body.token) {
				error = body.error ?? t('meet.invalidLink');
				return;
			}
			// Hand the devices off to LiveKit's own capture rather than holding two readers open.
			stopPreview();
			session = { url: body.url, token: body.token, displayName };
		} catch {
			error = t('common.networkError');
		} finally {
			joining = false;
		}
	}

	function onleave() {
		session = null;
		left = true;
	}
</script>

<svelte:head><title>{t('meet.title', { app: APP_NAME })}</title></svelte:head>

{#if session}
	<CallStage
		url={session.url}
		token={session.token}
		displayName={session.displayName}
		initialMicEnabled={micOn}
		initialCameraEnabled={cameraOn}
		initialMicDeviceId={micDeviceId}
		initialCameraDeviceId={cameraDeviceId}
		{onleave}
	/>
{:else}
	<div class="auth-shell">
		<div class="auth-card">
			<div class="auth-brand">
				<div class="brand-icon"><Logo size={48} /></div>
				<h1>{left ? t('meet.leave') : t('meet.title', { app: APP_NAME })}</h1>
			</div>

			{#if !data.token}
				<p class="note">{t('meet.invalidLink')}</p>
			{:else if left}
				<p class="note">{t('meet.leave')}</p>
			{:else}
				<div class="lobby-preview">
					<div class="lobby-video">
						<video
							bind:this={previewVideoEl}
							class="lobby-video-el"
							autoplay
							playsinline
							muted
							hidden={!cameraOn}
						></video>
						{#if !cameraOn}
							<div class="lobby-avatar">{previewInitials}</div>
						{/if}
					</div>
					<div class="lobby-controls">
						<div class="lobby-btn-group">
							<button
								type="button"
								class="lobby-btn"
								class:lobby-btn-off={!micOn}
								onclick={toggleMic}
								aria-label={micOn ? t('meet.micOn') : t('meet.micOff')}
							>
								<Icon name={micOn ? 'mic-line' : 'mic-off-line'} size={18} />
							</button>
							<DeviceSelect kind="audioinput" deviceId={micDeviceId} label={t('meet.chooseMic')} onselect={selectMic} menuAlign="start" />
						</div>
						<div class="lobby-meter" aria-hidden="true">
							<div class="lobby-meter-fill" style="transform: scaleX({micOn ? micLevel : 0})"></div>
						</div>
						<div class="lobby-btn-group">
							<button
								type="button"
								class="lobby-btn"
								class:lobby-btn-off={!cameraOn}
								onclick={toggleCamera}
								aria-label={cameraOn ? t('meet.cameraOn') : t('meet.cameraOff')}
							>
								<Icon name={cameraOn ? 'camera-line' : 'camera-off-line'} size={18} />
							</button>
							<DeviceSelect kind="videoinput" deviceId={cameraDeviceId} label={t('meet.chooseCamera')} onselect={selectCamera} menuAlign="end" />
						</div>
					</div>
					{#if deviceError}<p class="note lobby-error">{deviceError}</p>{/if}
				</div>

				<form class="mt-8 space-y-4" onsubmit={join}>
					<div>
						<label for="name" class="text-sm text-[var(--color-text-secondary)]">
							{t('meet.yourName')}
						</label>
						<input
							id="name"
							type="text"
							bind:value={name}
							maxlength={100}
							placeholder={t('meet.namePlaceholder')}
							autocomplete="name"
							class="auth-input"
						/>
					</div>

					{#if error}
						<p class="text-sm text-[var(--color-danger)]">{error}</p>
					{/if}

					<button type="submit" disabled={joining} class="btn-primary mt-2 w-full py-2.5">
						{joining ? t('meet.joining') : t('meet.join')}
					</button>
				</form>
			{/if}
		</div>
	</div>
{/if}

<style>
	.auth-brand {
		display: flex;
		flex-direction: column;
		align-items: center;
		text-align: center;
	}

	.brand-icon {
		display: flex;
		margin-bottom: 1rem;
		border-radius: 0.75rem;
		box-shadow: var(--shadow-sm);
	}

	.note {
		margin-top: 1rem;
		font-size: 0.875rem;
		line-height: 1.5;
		text-align: center;
		color: var(--color-text-secondary);
	}

	.lobby-preview {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.75rem;
		margin-top: 1.5rem;
	}

	.lobby-video {
		position: relative;
		width: 100%;
		aspect-ratio: 4 / 3;
		border-radius: 0.75rem;
		overflow: hidden;
		background: #1c1c1f;
	}

	.lobby-video-el {
		width: 100%;
		height: 100%;
		object-fit: cover;
		transform: scaleX(-1);
	}

	.lobby-avatar {
		position: absolute;
		inset: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		font-size: 1.75rem;
		font-weight: 600;
		color: rgba(255, 255, 255, 0.9);
		background: var(--color-accent, #3b82f6);
	}

	.lobby-controls {
		display: flex;
		align-items: center;
		gap: 0.625rem;
	}

	.lobby-btn-group {
		position: relative;
		--call-bar-bg: var(--color-surface-2, #26262b);
	}

	.lobby-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 40px;
		height: 40px;
		flex-shrink: 0;
		border: none;
		border-radius: 999px;
		background: var(--color-surface-2, #26262b);
		color: var(--color-text-primary, #fff);
		cursor: pointer;
	}

	.lobby-btn-off {
		background: #dc2626;
		color: #fff;
	}

	.lobby-meter {
		width: 80px;
		height: 6px;
		border-radius: 999px;
		background: var(--color-surface-2, #26262b);
		overflow: hidden;
	}

	.lobby-meter-fill {
		width: 100%;
		height: 100%;
		transform-origin: left;
		background: #22c55e;
		transition: transform 60ms linear;
	}

	.lobby-error {
		margin-top: 0;
	}
</style>
