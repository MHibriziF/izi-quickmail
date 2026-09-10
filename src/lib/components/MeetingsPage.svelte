<script lang="ts">
	import { t } from '$lib/i18n';
	import StackHeader from './StackHeader.svelte';
	import type { Meeting } from '$lib/server/meetings';

	let { meetings }: { meetings: Meeting[] } = $props();

	let busyId = $state('');
	let copiedId = $state('');
	let error = $state('');

	async function regenerate(id: string) {
		if (busyId) return;
		busyId = id;
		error = '';

		try {
			const response = await fetch(`/api/meetings/${encodeURIComponent(id)}/rotate`, { method: 'POST' });
			const body = (await response.json().catch(() => ({}))) as { joinUrl?: string; error?: string };
			if (!response.ok || !body.joinUrl) {
				error = body.error ?? t('meetings.couldNotRegenerate');
				return;
			}
			await copyLink(id, body.joinUrl);
		} catch {
			error = t('common.networkError');
		} finally {
			busyId = '';
		}
	}

	async function copyLink(id: string, joinUrl: string) {
		try {
			await navigator.clipboard.writeText(joinUrl);
			copiedId = id;
			setTimeout(() => {
				if (copiedId === id) copiedId = '';
			}, 2000);
		} catch {
			// Clipboard access denied — the link was already regenerated, nothing more to do.
		}
	}
</script>

<StackHeader title={t('meetings.heading')}>
	<div class="meetings-page">
		{#if error}
			<p class="meetings-error">{error}</p>
		{/if}

		{#if meetings.length === 0}
			<p class="meetings-empty">{t('meetings.empty')}</p>
		{:else}
			<ul class="meetings-list">
				{#each meetings as meeting (meeting.id)}
					<li class="meetings-row">
						<div class="meetings-row-info">
							<span class="meetings-row-title">{meeting.title || meeting.id}</span>
							<span class="meetings-row-date">{new Date(meeting.created_at).toLocaleString()}</span>
						</div>
						<button
							type="button"
							class="meetings-row-action"
							disabled={busyId === meeting.id}
							onclick={() => regenerate(meeting.id)}
						>
							{copiedId === meeting.id ? t('meetings.linkCopied') : t('meetings.regenerateLink')}
						</button>
					</li>
				{/each}
			</ul>
		{/if}
	</div>
</StackHeader>

<style>
	.meetings-page {
		display: flex;
		flex-direction: column;
		gap: 1rem;
		padding: 1rem;
	}

	.meetings-error {
		font-size: 0.875rem;
		color: var(--color-danger);
	}

	.meetings-empty {
		font-size: 0.875rem;
		color: var(--color-text-secondary);
	}

	.meetings-list {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		list-style: none;
		margin: 0;
		padding: 0;
	}

	.meetings-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		padding: 0.75rem;
		border: 1px solid var(--color-line);
		border-radius: 0.5rem;
	}

	.meetings-row-info {
		display: flex;
		flex-direction: column;
		gap: 0.125rem;
		min-width: 0;
	}

	.meetings-row-title {
		font-size: 0.9rem;
		font-weight: 500;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.meetings-row-date {
		font-size: 0.75rem;
		color: var(--color-text-secondary);
	}

	.meetings-row-action {
		flex-shrink: 0;
		padding: 0.375rem 0.75rem;
		font-size: 0.8125rem;
		border: 1px solid var(--color-line);
		border-radius: 0.375rem;
		background: transparent;
		cursor: pointer;
	}

	.meetings-row-action:hover {
		background: var(--color-surface-hover);
	}
</style>
