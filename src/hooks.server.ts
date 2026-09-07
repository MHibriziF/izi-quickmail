import { redirect, type Handle } from '@sveltejs/kit';
import { authorizeApiRequest } from '$lib/server/api-access';
import { getUserByApiToken, readBearerToken } from '$lib/server/api-tokens';
import { countUsers, getUserFromSession, readSessionToken } from '$lib/server/auth';
import { DOMAIN_COOKIE, UI_THEME_COOKIE, UI_THEME_COOKIE_MAX_AGE } from '$lib/server/constants';
import { listAddressesForUser, listDomains } from '$lib/server/domains';
import { getUserLocale } from '$lib/server/locale';
import { ensureSchema } from '$lib/server/migrate';
import { getUserUiTheme } from '$lib/server/ui-theme';
import { BUILTIN_THEME_IDS, DEFAULT_UI_THEME, parseThemeId } from '$lib/ui-theme/ids';
import {
	DEFAULT_LOCALE,
	LOCALE_COOKIE,
	LOCALE_COOKIE_MAX_AGE,
	localeFromAcceptLanguage,
	matchLocale
} from '$lib/i18n/locales';

const PUBLIC_PREFIXES = [
	'/login',
	'/setup',
	// Account recovery is reached precisely when the user cannot sign in, and
	// the confirmation link is clicked from another inbox. Each of these carries
	// its own single-use token; the path being public grants nothing on its own.
	'/forgot',
	'/reset',
	'/account/recovery',
	'/api/auth',
	'/api/setup',
	'/api/webhooks',
	'/install.sh'
];

function isPublicPath(pathname: string): boolean {
	return PUBLIC_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

function jsonError(error: string, status: number): Response {
	return new Response(JSON.stringify({ error }), {
		status,
		headers: { 'Content-Type': 'application/json' }
	});
}

/**
 * Serves the page with the shell already named on `<html>`.
 *
 * Stamping it server-side is what stops the wrong shell being painted and then
 * replaced once the client works out which theme this user chose.
 */
function render(
	event: Parameters<Handle>[0]['event'],
	resolve: Parameters<Handle>[0]['resolve']
): ReturnType<Handle> {
	const uiTheme = event.locals.uiTheme || DEFAULT_UI_THEME;
	const locale = event.locals.locale || DEFAULT_LOCALE;
	return resolve(event, {
		transformPageChunk: ({ html }) =>
			html.replace('<html lang="en">', `<html lang="${locale}" data-ui-theme="${uiTheme}">`)
	});
}

export const handle: Handle = async ({ event, resolve }) => {
	const db = event.platform?.env.DB;
	event.locals.user = null;
	event.locals.authMethod = null;
	event.locals.apiScopes = [];
	event.locals.apiTokenId = null;
	event.locals.domains = [];
	event.locals.addresses = [];
	event.locals.activeDomainId = null;
	event.locals.uiTheme = parseThemeId(event.cookies.get(UI_THEME_COOKIE), BUILTIN_THEME_IDS);
	// The cookie is the returning visitor; Accept-Language is the first one.
	event.locals.locale =
		matchLocale(event.cookies.get(LOCALE_COOKIE)) ??
		localeFromAcceptLanguage(event.request.headers.get('accept-language'));

	const { pathname } = event.url;

	// Deploy to Cloudflare provisions D1 but never migrates it, so the schema is
	// brought up to date here rather than leaving a fresh deploy broken until
	// someone runs wrangler by hand. Cached per isolate; a no-op once applied.
	if (db) {
		try {
			await ensureSchema(db);
		} catch (error) {
			console.error('Could not apply database migrations', error);
		}
	}

	if (db) {
		const session = readSessionToken(event.cookies);
		event.locals.user = await getUserFromSession(db, session);
		if (event.locals.user) {
			event.locals.authMethod = 'session';
		} else if (pathname.startsWith('/api/')) {
			const bearer = readBearerToken(event.request);
			if (bearer) {
				const auth = await getUserByApiToken(db, bearer);
				if (auth) {
					event.locals.user = auth.user;
					event.locals.authMethod = 'api_token';
					event.locals.apiScopes = auth.scopes;
					event.locals.apiTokenId = auth.tokenId;
				}
			}
		}
	}

	// Webhooks authenticate with a signature, not a session.
	if (pathname.startsWith('/api/webhooks/')) {
		return render(event, resolve);
	}

	if (db && event.locals.user) {
		const [domains, addresses] = await Promise.all([
			listDomains(db),
			listAddressesForUser(db, event.locals.user.id)
		]);

		event.locals.domains = domains;
		event.locals.addresses = addresses;

		// Scripts pass `?domain=`; the dashboard uses a cookie.
		const requested = pathname.startsWith('/api/')
			? event.url.searchParams.get('domain')
			: event.cookies.get(DOMAIN_COOKIE);
		event.locals.activeDomainId =
			requested && domains.some((domain) => domain.id === requested) ? requested : null;
	}

	if (pathname.startsWith('/api/')) {
		if (isPublicPath(pathname)) {
			return render(event, resolve);
		}
		if (!event.locals.user || !event.locals.authMethod) {
			return jsonError('Unauthorized', 401);
		}

		const access = authorizeApiRequest({
			pathname,
			method: event.request.method,
			authMethod: event.locals.authMethod,
			scopes: event.locals.apiScopes
		});
		if (!access.ok) {
			return jsonError(access.error, access.status);
		}

		return render(event, resolve);
	}

	if (db && event.locals.user) {
		const [storedTheme, storedLocale] = await Promise.all([
			getUserUiTheme(db, event.locals.user.id),
			getUserLocale(db, event.locals.user.id)
		]);
		event.locals.uiTheme = storedTheme;
		event.locals.locale = storedLocale;
		// Mirrored into cookies so the next first paint does not have to wait on
		// the database to know which shell and language to render.
		if (event.cookies.get(UI_THEME_COOKIE) !== storedTheme) {
			event.cookies.set(UI_THEME_COOKIE, storedTheme, {
				path: '/',
				maxAge: UI_THEME_COOKIE_MAX_AGE,
				sameSite: 'lax',
				httpOnly: false
			});
		}
		if (event.cookies.get(LOCALE_COOKIE) !== storedLocale) {
			event.cookies.set(LOCALE_COOKIE, storedLocale, {
				path: '/',
				maxAge: LOCALE_COOKIE_MAX_AGE,
				sameSite: 'lax',
				httpOnly: false
			});
		}
	}

	const needsSetup = db ? (await countUsers(db)) === 0 : false;

	if (
		needsSetup &&
		pathname !== '/setup' &&
		pathname !== '/install.sh'
	) {
		throw redirect(303, '/setup');
	}

	if (pathname === '/setup') {
		if (!needsSetup && event.locals.user) {
			throw redirect(303, '/inbox');
		}
		if (!needsSetup && !event.locals.user) {
			throw redirect(303, '/login');
		}
		return render(event, resolve);
	}

	if (pathname === '/login') {
		if (event.locals.user) {
			throw redirect(303, '/inbox');
		}
		return render(event, resolve);
	}

	if (isPublicPath(pathname)) {
		return render(event, resolve);
	}

	if (!event.locals.user) {
		throw redirect(303, '/login');
	}

	// Nothing works until a provider domain is connected and the user owns an
	// address on it, so send them through onboarding first.
	const needsOnboarding = event.locals.domains.length === 0 || event.locals.addresses.length === 0;

	if (needsOnboarding && pathname !== '/onboarding') {
		throw redirect(303, '/onboarding');
	}

	if (!needsOnboarding && pathname === '/onboarding') {
		throw redirect(303, '/inbox');
	}

	if (pathname.startsWith('/admin') && !event.locals.user.is_admin) {
		throw redirect(303, '/inbox');
	}

	return render(event, resolve);
};
