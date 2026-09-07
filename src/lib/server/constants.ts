export {
	MAX_ATTACHMENT_BYTES,
	MAX_ATTACHMENTS_PER_EMAIL,
	MAX_TOTAL_ATTACHMENT_BYTES
} from '$lib/constants';
export const SESSION_COOKIE = 'mail_session';
export const SESSION_DAYS = 7;
export const MAX_BODY_BYTES = 256_000;
/** Cookie remembering which connected domain the dashboard is filtered to. */
export const DOMAIN_COOKIE = 'mail_domain';
/** Cookie mirroring the user's shell choice, so the first paint is right. */
export const UI_THEME_COOKIE = 'qi_ui_theme';
export const UI_THEME_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;
