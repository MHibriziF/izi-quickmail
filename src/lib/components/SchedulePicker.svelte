<script lang="ts">
	import Icon from './Icon.svelte';
	import { MAX_SCHEDULE_DAYS } from '$lib/constants';

	let {
		open = $bindable(false),
		onpick
	}: {
		open: boolean;
		onpick: (isoTime: string) => void;
	} = $props();

	/** Local-time helpers — the picker works in the reader's own day, not UTC. */
	function at(date: Date, hour: number): Date {
		const copy = new Date(date);
		copy.setHours(hour, 0, 0, 0);
		return copy;
	}

	function addDays(days: number): Date {
		const date = new Date();
		date.setDate(date.getDate() + days);
		return date;
	}

	/** Days until the next Monday; 7 if today is already Monday. */
	function daysUntilMonday(): number {
		const today = new Date().getDay();
		return (8 - today) % 7 || 7;
	}

	const presets = $derived.by(() => {
		const now = new Date();
		const options: Array<{ label: string; when: Date }> = [];

		// Only offer later today while there is still a useful gap.
		const thisAfternoon = at(now, 13);
		if (thisAfternoon.getTime() - now.getTime() > 60 * 60 * 1000) {
			options.push({ label: 'This afternoon', when: thisAfternoon });
		}

		const thisEvening = at(now, 18);
		if (thisEvening.getTime() - now.getTime() > 60 * 60 * 1000) {
			options.push({ label: 'This evening', when: thisEvening });
		}

		options.push({ label: 'Tomorrow morning', when: at(addDays(1), 8) });
		options.push({ label: 'Tomorrow afternoon', when: at(addDays(1), 13) });
		options.push({ label: 'Monday morning', when: at(addDays(daysUntilMonday()), 8) });

		return options;
	});

	const dayFormat = new Intl.DateTimeFormat(undefined, {
		weekday: 'short',
		day: 'numeric',
		month: 'short',
		hour: 'numeric',
		minute: '2-digit'
	});

	let custom = $state('');
	let error = $state('');

	const pad = (n: number) => String(n).padStart(2, '0');
	const localInputValue = (date: Date) =>
		`${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;

	/** Resend will not hold a message longer than this, so the field stops there. */
	const customMax = $derived(
		localInputValue(new Date(Date.now() + MAX_SCHEDULE_DAYS * 24 * 60 * 60 * 1000))
	);

	/** `datetime-local` wants local time with no zone, trimmed to minutes. */
	const customMin = $derived(localInputValue(new Date(Date.now() + 60_000)));

	function choose(when: Date) {
		onpick(when.toISOString());
		open = false;
	}

	function chooseCustom(event: SubmitEvent) {
		event.preventDefault();
		error = '';

		const when = new Date(custom);
		if (Number.isNaN(when.getTime())) {
			error = 'Pick a date and time';
			return;
		}
		if (when.getTime() <= Date.now()) {
			error = 'Pick a time in the future';
			return;
		}
		if (when.getTime() > Date.now() + MAX_SCHEDULE_DAYS * 24 * 60 * 60 * 1000) {
			error = `Scheduled send only reaches ${MAX_SCHEDULE_DAYS} days ahead`;
			return;
		}

		choose(when);
	}

	function onKeydown(event: KeyboardEvent) {
		if (event.key === 'Escape') open = false;
	}
</script>

<svelte:window onkeydown={onKeydown} />

{#if open}
	<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
	<div class="scrim" onclick={() => (open = false)}></div>

	<div class="sheet" role="dialog" aria-modal="true" aria-label="Schedule send">
		<div class="head">
			<h2>Schedule send</h2>
			<button type="button" class="icon-btn" aria-label="Close" onclick={() => (open = false)}>
				<Icon name="close-line" size={16} />
			</button>
		</div>

		<ul class="presets">
			{#each presets as preset (preset.label)}
				<li>
					<button type="button" class="preset" onclick={() => choose(preset.when)}>
						<span class="preset-label">{preset.label}</span>
						<span class="preset-when">{dayFormat.format(preset.when)}</span>
					</button>
				</li>
			{/each}
		</ul>

		<form class="custom" onsubmit={chooseCustom}>
			<label class="field-title" for="custom-time">Or pick a date and time</label>
			<input
				id="custom-time"
				class="text-input"
				type="datetime-local"
				bind:value={custom}
				min={customMin}
				max={customMax}
			/>
			{#if error}<p class="error">{error}</p>{/if}
			<button type="submit" class="btn-primary schedule-btn">Schedule</button>
		</form>
	</div>
{/if}

<style>
	.scrim {
		position: fixed;
		inset: 0;
		z-index: 40;
		background: var(--color-scrim);
	}

	.sheet {
		position: fixed;
		z-index: 41;
		left: 50%;
		top: 50%;
		transform: translate(-50%, -50%);
		width: min(22rem, calc(100vw - 2rem));
		max-height: calc(100vh - 3rem);
		overflow-y: auto;
		padding: 1.125rem;
		border-radius: 1.25rem;
		background: var(--color-surface);
		box-shadow: var(--shadow-md);
	}

	.head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
	}

	.head h2 {
		margin: 0;
		font-size: 0.9375rem;
		font-weight: 600;
	}

	.presets {
		display: flex;
		flex-direction: column;
		gap: 0.125rem;
		margin: 0.875rem 0 0;
		padding: 0;
		list-style: none;
	}

	.preset {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 0.75rem;
		width: 100%;
		padding: 0.5rem 0.625rem;
		border-radius: 0.625rem;
		text-align: left;
		transition: background 0.12s;
	}

	.preset:hover {
		background: var(--color-surface-muted);
	}

	.preset-label {
		font-size: 0.875rem;
		color: var(--color-text);
	}

	.preset-when {
		font-size: 0.75rem;
		color: var(--color-muted);
		white-space: nowrap;
	}

	.custom {
		display: flex;
		flex-direction: column;
		gap: 0.375rem;
		margin-top: 0.875rem;
		padding-top: 0.875rem;
		border-top: 1px solid var(--color-line);
	}

	.field-title {
		font-size: 0.8125rem;
		color: var(--color-text-secondary);
	}

	.text-input {
		width: 100%;
		padding: 0.5rem 0.625rem;
		border-radius: 0.625rem;
		font-size: 0.875rem;
		color: var(--color-text);
		background: var(--color-surface-muted);
		box-shadow: inset 0 0 0 1px var(--color-line);
	}

	.text-input:focus {
		outline: none;
		box-shadow: inset 0 0 0 1px var(--color-focus-line), 0 0 0 3px var(--color-focus-halo);
	}

	.schedule-btn {
		margin-top: 0.25rem;
		justify-content: center;
	}

	.error {
		margin: 0;
		font-size: 0.8125rem;
		color: var(--color-danger);
	}
</style>
