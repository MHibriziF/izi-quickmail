<script lang="ts">
	import SettingsPage from '$lib/components/SettingsPage.svelte';
	import type { LayoutData } from './$types';

	let { data }: { data: LayoutData } = $props();
</script>

<SettingsPage {data} section="all" />
