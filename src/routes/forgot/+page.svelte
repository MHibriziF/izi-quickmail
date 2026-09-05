<script lang="ts">
	import Logo from '$lib/components/Logo.svelte';
	import { APP_NAME } from '$lib/constants';

	let email = $state('');
	let sent = $state(false);
	let message = $state('');
	let loading = $state(false);

	async function submit(event: SubmitEvent) {
		event.preventDefault();
		loading = true;
		try {
			const res = await fetch('/api/auth/forgot', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ email })
			});
			const body = await res.json();
			// The server answers the same way regardless, so there is nothing to
			// branch on here either.
			message = body.message ?? 'Check your recovery address.';
			sent = true;
		} catch {
			message = 'Network error. Try again.';
		} finally {
			loading = false;
		}
	}
</script>

<svelte:head><title>Forgot password — {APP_NAME}</title></svelte:head>

<div class="auth-shell">
	<div class="auth-card">
		<div class="auth-brand">
			<div class="brand-icon"><Logo size={48} /></div>
			<h1>Forgot password</h1>
		</div>

		{#if sent}
			<p class="note">{message}</p>
			<a href="/login" class="btn-primary block-link">Back to sign in</a>
		{:else}
			<p class="note">
				Enter your mailbox address. If it has a confirmed recovery address, we'll send a reset
				link there.
			</p>

			<form class="mt-8 space-y-4" onsubmit={submit}>
				<div>
					<label for="email" class="text-sm text-[var(--color-text-secondary)]">Email</label>
					<input
						id="email"
						type="email"
						bind:value={email}
						required
						autocomplete="username"
						class="auth-input"
					/>
				</div>

				<button type="submit" disabled={loading} class="btn-primary mt-2 w-full py-2.5">
					{loading ? 'Sending…' : 'Send reset link'}
				</button>
			</form>

			<a href="/login" class="back">Back to sign in</a>
		{/if}
	</div>
</div>

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

	.block-link {
		display: flex;
		width: 100%;
		margin-top: 1.5rem;
		padding-top: 0.625rem;
		padding-bottom: 0.625rem;
	}

	.back {
		display: block;
		margin-top: 1.25rem;
		font-size: 0.8125rem;
		text-align: center;
		color: var(--color-text-secondary);
	}

	.back:hover {
		color: var(--color-text);
	}
</style>
