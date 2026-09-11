<script lang="ts">
	import Icon from './Icon.svelte';

	let {
		kind,
		deviceId = '',
		label,
		onselect,
		menuAlign = 'center'
	}: {
		kind: 'audioinput' | 'videoinput';
		deviceId?: string;
		label: string;
		onselect: (deviceId: string) => void;
		/** Which side the popup menu opens from, so it never spills past the call bar's edge. */
		menuAlign?: 'center' | 'start' | 'end';
	} = $props();

	let open = $state(false);
	let devices = $state<MediaDeviceInfo[]>([]);
	let rootEl = $state<HTMLDivElement>();

	async function loadDevices() {
		try {
			const all = await navigator.mediaDevices.enumerateDevices();
			devices = all.filter((d) => d.kind === kind);
		} catch {
			devices = [];
		}
	}

	function toggle() {
		open = !open;
		if (open) void loadDevices();
	}

	function select(id: string) {
		open = false;
		onselect(id);
	}

	function onWindowClick(event: MouseEvent) {
		if (open && rootEl && !rootEl.contains(event.target as Node)) open = false;
	}

	$effect(() => {
		if (!navigator.mediaDevices?.enumerateDevices) return;
		navigator.mediaDevices.addEventListener('devicechange', loadDevices);
		return () => navigator.mediaDevices.removeEventListener('devicechange', loadDevices);
	});
</script>

<svelte:window onclick={onWindowClick} />

<div class="device-select" bind:this={rootEl}>
	<button type="button" class="device-select-toggle" onclick={toggle} aria-label={label}>
		<Icon name="arrow-up-s-line" size={14} />
	</button>
	{#if open}
		<ul class="device-select-menu" class:align-start={menuAlign === 'start'} class:align-end={menuAlign === 'end'}>
			{#if devices.length === 0}
				<li class="device-select-empty">{label}</li>
			{:else}
				{#each devices as device (device.deviceId)}
					<li>
						<button
							type="button"
							class="device-select-option"
							class:selected={device.deviceId === deviceId}
							onclick={() => select(device.deviceId)}
						>
							{device.label || label}
						</button>
					</li>
				{/each}
			{/if}
		</ul>
	{/if}
</div>

<style>
	/*
	 * A left-hand segment inside the same pill as the mic/camera toggle
	 * (see .call-btn-pill / .lobby-btn-pill) — one continuous chip, not a
	 * separate floating circle, matching Meet's layout. Each segment paints
	 * its own rounded corner on its outer edge (nothing here relies on the
	 * parent's overflow:hidden) because that would also clip this menu,
	 * which needs to render outside the pill's own box when it opens.
	 */
	.device-select {
		position: relative;
		height: 100%;
	}

	.device-select-toggle {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 32px;
		height: 100%;
		border: none;
		border-radius: 999px 0 0 999px;
		background: var(--device-select-bg, #45454d);
		color: #fff;
		cursor: pointer;
	}

	.device-select-toggle:hover {
		background: var(--device-select-bg-hover, #525260);
	}

	.device-select-menu {
		position: absolute;
		bottom: calc(100% + 0.5rem);
		left: 50%;
		transform: translateX(-50%);
		z-index: 20;
		display: flex;
		flex-direction: column;
		gap: 0.125rem;
		min-width: 200px;
		max-width: 280px;
		margin: 0;
		padding: 0.375rem;
		list-style: none;
		border-radius: 0.625rem;
		background: #1c1c1f;
		box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
	}

	.device-select-menu.align-start {
		left: 0;
		transform: none;
	}

	.device-select-menu.align-end {
		left: auto;
		right: 0;
		transform: none;
	}

	.device-select-empty {
		padding: 0.375rem 0.5rem;
		font-size: 0.75rem;
		color: rgba(255, 255, 255, 0.5);
	}

	.device-select-option {
		width: 100%;
		padding: 0.375rem 0.5rem;
		border: none;
		border-radius: 0.375rem;
		background: transparent;
		color: #fff;
		font-size: 0.75rem;
		text-align: left;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		cursor: pointer;
	}

	.device-select-option:hover {
		background: rgba(255, 255, 255, 0.1);
	}

	.device-select-option.selected {
		background: rgba(255, 255, 255, 0.16);
		font-weight: 600;
	}
</style>
