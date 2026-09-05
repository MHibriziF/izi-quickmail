/**
 * Shared with the settings panel, which cannot import from `$lib/server`.
 * The server module re-exports these so the allowed values are defined once.
 */

/** 0 turns automatic emptying off. */
export const TRASH_RETENTION_CHOICES = [0, 7, 30, 60, 90, 180, 365] as const;
export const SWEEP_AGE_CHOICES = [30, 90, 180, 365] as const;
