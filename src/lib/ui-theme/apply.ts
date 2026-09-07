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
 * Covers the page while the shell is replaced.
 *
 * Switching reloads the document, and a reload of an app this size leaves the
 * old shell on screen and then blanks it — which reads as a fault rather than
 * as something in progress. The overlay is written straight into the DOM, not
 * rendered by Svelte, because the component tree is about to be torn down; the
 * browser keeps painting it until the new document commits.
 */
function paintSwitchingOverlay(message: string): void {
	const overlay = document.createElement('div');
	overlay.setAttribute('role', 'status');
	overlay.setAttribute('aria-live', 'polite');
	overlay.style.cssText = [
		'position:fixed',
		'inset:0',
		'z-index:9999',
		'display:flex',
		'align-items:center',
		'justify-content:center',
		'gap:0.625rem',
		'font:500 0.875rem/1.4 inherit',
		// Falls back for a theme that has not defined them.
		'color:var(--color-text, #111)',
		'background:var(--color-bg, #fff)'
	].join(';');

	const spinner = document.createElement('span');
	spinner.style.cssText = [
		'width:1rem',
		'height:1rem',
		'border-radius:50%',
		'border:2px solid var(--color-line, #ddd)',
		'border-top-color:var(--color-accent, #90ac9a)',
		'animation:qi-switch-spin 0.7s linear infinite'
	].join(';');

	const style = document.createElement('style');
	style.textContent = '@keyframes qi-switch-spin{to{transform:rotate(360deg)}}';

	overlay.append(style, spinner, document.createTextNode(message));
	document.body.append(overlay);
}

/**
 * A theme change swaps the whole shell, so the page is reloaded rather than
 * re-mounted underneath the user.
 */
export async function switchUiTheme(id: string, switchingLabel = 'Switching…'): Promise<void> {
	persistUiTheme(id);
	paintSwitchingOverlay(switchingLabel);

	try {
		await fetch('/api/settings/ui-theme', {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ theme: id })
		});
	} finally {
		// Reload regardless: the cookie and storage already carry the choice, so
		// the new document renders the right shell even if the save failed.
		window.location.reload();
	}
}
