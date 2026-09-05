<script lang="ts">
	import { untrack } from 'svelte';
	import Icon from '$lib/components/Icon.svelte';

	let {
		email: initialEmail,
		pending: initialPending
	}: {
		email: string | null;
		pending: string | null;
	} = $props();

	let email = $state(untrack(() => initialEmail));
	let pending = $state(untrack(() => initialPending));

	let draft = $state('');
	let password = $state('');
	let busy = $state(false);
	let error = $state('');
	let notice = $state('');

	async function call(payload: Record<string, unknown>) {
		busy = true;
		error = '';
		notice = '';
		try {
			const res = await fetch('/api/settings/recovery-email', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(payload)
			});
			const body = await res.json();
			if (!res.ok) {
				error = body.error ?? 'Something went wrong';
				return null;
			}
			email = body.email ?? null;
			pending = body.pending ?? null;
			password = '';
			return body;
		} catch {
			error = 'Network error';
			return null;
		} finally {
			busy = false;
		}
	}

	async function save(event: SubmitEvent) {
		event.preventDefault();
		const body = await call({ email: draft, password });
		if (!body) return;
		draft = '';
		notice = `Confirmation sent to ${body.pending}. Click the link in it to finish.`;
	}

	async function clear() {
		const body = await call({ action: 'clear', password });
		if (body) notice = 'Recovery address removed.';
	}
</script>

<section class="surface-lg card">
	<h2><Icon name="lifebuoy-line" size={18} /> Recovery address</h2>

	<p class="card-hint">
		An address outside this mailbox — your Gmail, say. It is where a password reset link goes, and
		where we tell you about security changes. A link sent to an address you can only read by
		signing in would be no use when you cannot sign in.
	</p>

	{#if email}
		<p class="current">
			<span class="on-badge">Confirmed</span>
			{email}
		</p>
	{:else if pending}
		<p class="current">
			<span class="wait-badge">Unconfirmed</span>
			{pending} — click the link we sent before it can reset your password.
		</p>
	{:else}
		<p class="warn">
			None set. Without one, a forgotten password can only be fixed from the command line.
		</p>
	{/if}

	<form class="stack" onsubmit={save}>
		<label class="field-title" for="recovery-email">
			{email || pending ? 'Change to' : 'Recovery address'}
		</label>
		<input
			id="recovery-email"
			class="text-input"
			type="email"
			bind:value={draft}
			placeholder="you@gmail.com"
			autocomplete="email"
			required
		/>

		<label class="field-title" for="recovery-password">Password</label>
		<input
			id="recovery-password"
			class="text-input"
			type="password"
			bind:value={password}
			autocomplete="current-password"
			required
		/>

		<div class="actions">
			{#if email || pending}
				<button type="button" class="btn-ghost danger" disabled={busy} onclick={clear}>
					Remove
				</button>
			{/if}
			<button type="submit" class="btn-primary" disabled={busy}>
				{busy ? 'Sending…' : 'Send confirmation'}
			</button>
		</div>
	</form>

	{#if error}<p class="error">{error}</p>{/if}
	{#if notice}<p class="saved">{notice}</p>{/if}
</section>

<style>
	/* Page-scoped elsewhere in this codebase, so redeclared here — see
	   TwoFactorPanel for the same set. */
	.card {
		margin-top: 1.5rem;
		padding: 1.5rem;
	}

	.card h2 {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		font-size: 0.9375rem;
		font-weight: 600;
	}

	@media (max-width: 900px) {
		.card {
			margin-top: 1rem;
			padding: 1.25rem 1rem;
			box-shadow: none;
		}
	}

	.card-hint {
		margin-top: 0.375rem;
		font-size: 0.8125rem;
		line-height: 1.5;
		color: var(--color-muted);
	}

	.field-title {
		display: block;
		font-size: 0.8125rem;
		color: var(--color-text-secondary);
	}

	.text-input {
		width: 100%;
		padding: 0.625rem 0.75rem;
		border-radius: 0.625rem;
		font-size: 0.875rem;
		color: var(--color-text);
		background: var(--color-surface-muted);
		box-shadow: inset 0 0 0 1px var(--color-line);
		transition: box-shadow 0.15s;
	}

	.text-input::placeholder {
		color: var(--color-muted);
	}

	.text-input:focus {
		outline: none;
		box-shadow: inset 0 0 0 1px var(--color-focus-line), 0 0 0 3px var(--color-focus-halo);
	}

	.error {
		margin-top: 0.75rem;
		font-size: 0.8125rem;
		color: var(--color-danger);
	}

	.saved {
		margin-top: 0.75rem;
		font-size: 0.8125rem;
		color: var(--color-accent-text);
	}

	.danger {
		color: var(--color-danger);
	}

	.stack {
		display: flex;
		flex-direction: column;
		gap: 0.375rem;
		margin-top: 0.875rem;
	}

	.actions {
		display: flex;
		flex-wrap: wrap;
		justify-content: flex-end;
		gap: 0.5rem;
		margin-top: 0.75rem;
	}

	.current {
		margin-top: 0.75rem;
		font-size: 0.8125rem;
		line-height: 1.5;
		color: var(--color-text-secondary);
	}

	.warn {
		margin-top: 0.75rem;
		font-size: 0.8125rem;
		color: var(--tone-warn-fg);
	}

	.on-badge,
	.wait-badge {
		display: inline-block;
		margin-right: 0.375rem;
		padding: 0.0625rem 0.4rem;
		border-radius: 9999px;
		font-size: 0.6875rem;
		font-weight: 700;
	}

	.on-badge {
		color: var(--tone-good-fg);
		background: var(--tone-good-bg);
	}

	.wait-badge {
		color: var(--tone-warn-fg);
		background: var(--tone-warn-bg);
	}
</style>
