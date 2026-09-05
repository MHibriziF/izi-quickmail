<script lang="ts">
	import { APP_NAME } from '$lib/constants';

	// The app mark: a solid envelope cut out of a sage tile. Kept inline so it
	// stays crisp at any size and can be dropped straight into a flex row.
	// Filled rather than stroked so it survives being rendered at 16-32px.
	let {
		size = 30,
		class: className = ''
	}: {
		size?: number;
		class?: string;
	} = $props();
</script>

<svg
	class={className}
	width={size}
	height={size}
	viewBox="0 0 64 64"
	xmlns="http://www.w3.org/2000/svg"
	role="img"
	aria-label={APP_NAME}
>
	<rect width="64" height="64" rx="15" fill="#90ac9a" />
	<path
		d="M14 25a5 5 0 0 1 5-5h26a5 5 0 0 1 5 5v14a5 5 0 0 1-5 5H19a5 5 0 0 1-5-5z"
		fill="#14231a"
	/>
	<path
		d="M18.5 26.5 32 37l13.5-10.5"
		fill="none"
		stroke="#90ac9a"
		stroke-width="4"
		stroke-linecap="round"
		stroke-linejoin="round"
	/>
</svg>
