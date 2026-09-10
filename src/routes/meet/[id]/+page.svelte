<script lang="ts">
	import { t } from '$lib/i18n';
	import Logo from '$lib/components/Logo.svelte';
	import CallStage from '$lib/components/CallStage.svelte';
	import { APP_NAME } from '$lib/constants';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	let name = $state('');
	let joining = $state(false);
	let error = $state('');
	let session = $state<{ url: string; token: string } | null>(null);
	let left = $state(false);

	async function join(event: SubmitEvent) {
		event.preventDefault();
		if (joining) return;
		joining = true;
		error = '';

		try {
			const response = await fetch(`/api/meetings/join/${encodeURIComponent(data.id)}`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ token: data.token, name: name.trim() || undefined })
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
			session = { url: body.url, token: body.token };
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
	<CallStage url={session.url} token={session.token} {onleave} />
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
</style>
