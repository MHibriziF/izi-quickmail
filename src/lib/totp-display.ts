/**
 * Shared with the enrolment UI, which cannot import from `$lib/server`.
 * The server module re-exports it so there is still one implementation.
 */

/** Groups of four, the way authenticator apps display a manual key. */
export function formatSecretForDisplay(secret: string): string {
	return secret.replace(/(.{4})/g, '$1 ').trim();
}
