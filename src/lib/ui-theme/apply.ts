import { UI_THEME_COOKIE, UI_THEME_STORAGE_KEY } from './ids';

/** One year — the preference is a convenience, not a session. */
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

/**
 * Mirrors the server's choice into the document and the browser, so the shell
 * is already right on the next first paint rather than after hydration.
 */
export function persistUiTheme(id: string): void {
	document.documentElement.dataset.uiTheme = id;
	try {
		localStorage.setItem(UI_THEME_STORAGE_KEY, id);
	} catch {
		// Private browsing can refuse; the cookie still carries the choice.
	}
	document.cookie = `${UI_THEME_COOKIE}=${encodeURIComponent(id)}; path=/; max-age=${COOKIE_MAX_AGE}; samesite=lax`;
}

/**
 * A theme change swaps the whole shell, so the page is reloaded rather than
 * re-mounted underneath the user.
 */
export async function switchUiTheme(id: string): Promise<void> {
	persistUiTheme(id);
	await fetch('/api/settings/ui-theme', {
		method: 'PATCH',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ theme: id })
	});
	window.location.reload();
}
