import { json, type RequestHandler } from '@sveltejs/kit';
import { getDomainsService } from '$lib/server/domains';

export const PATCH: RequestHandler = async ({ params, request, locals, platform }) => {
	if (!platform?.env.DB || !locals.user) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	const domains = getDomainsService(platform);
	const body = (await request.json()) as {
		isDefault?: boolean;
		label?: string | null;
		signature?: string | null;
	};
	if (body.label !== undefined || body.signature !== undefined) {
		try {
			await domains.updateAddress(locals.user.id, params.id!, {
				label: body.label,
				signature: body.signature
			});
		} catch (error) {
			return json(
				{ error: error instanceof Error ? error.message : 'Could not update address' },
				{ status: 400 }
			);
		}
	}

	if (body.isDefault) {
		await domains.setDefaultAddress(locals.user.id, params.id!);
	}

	return json({ addresses: await domains.listAddressesForUser(locals.user.id) });
};

export const DELETE: RequestHandler = async ({ params, locals, platform }) => {
	if (!platform?.env.DB || !locals.user) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	const domains = getDomainsService(platform);
	const addresses = await domains.listAddressesForUser(locals.user.id);
	if (addresses.length <= 1) {
		return json({ error: 'Keep at least one address' }, { status: 400 });
	}

	await domains.deleteAddress(locals.user.id, params.id!);
	const remaining = await domains.listAddressesForUser(locals.user.id);

	// Never leave the user without a default sending identity.
	if (remaining.length > 0 && !remaining.some((address) => address.is_default)) {
		await domains.setDefaultAddress(locals.user.id, remaining[0].id);
	}

	return json({ addresses: await domains.listAddressesForUser(locals.user.id) });
};
