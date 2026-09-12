import { json, type RequestHandler } from '@sveltejs/kit';
import { ProviderError } from '$lib/server/context';
import { getDomainsService } from '$lib/server/domains';

/** PATCH — set the catch-all owner or re-sync status from the active provider. */
export const PATCH: RequestHandler = async ({ params, request, locals, platform }) => {
	if (!platform?.env.DB || !locals.user?.is_admin) {
		return json({ error: 'Forbidden' }, { status: 403 });
	}

	const domains = getDomainsService(platform);
	const domain = await domains.getDomain(params.id!);
	if (!domain) {
		return json({ error: 'Domain not connected' }, { status: 404 });
	}

	const body = (await request.json()) as {
		catchallUserId?: string | null;
		refresh?: boolean;
	};

	if (body.refresh) {
		try {
			return json({ domain: await domains.refreshDomain(domain.id) });
		} catch (error) {
			return json(
				{ error: error instanceof ProviderError ? error.message : 'Failed to refresh domain' },
				{ status: 502 }
			);
		}
	}

	if (body.catchallUserId !== undefined) {
		await domains.setCatchallUser(domain.id, body.catchallUserId || null);
	}

	return json({ domain: await domains.getDomain(domain.id) });
};

/** DELETE — stop using the domain here. The domain stays with the provider. */
export const DELETE: RequestHandler = async ({ params, locals, platform }) => {
	if (!platform?.env.DB || !locals.user?.is_admin) {
		return json({ error: 'Forbidden' }, { status: 403 });
	}

	await getDomainsService(platform).disconnectDomain(params.id!);
	return json({ ok: true });
};
