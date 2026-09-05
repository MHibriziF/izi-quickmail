import type { PageServerLoad } from './$types';
import { listApiTokens } from '$lib/server/api-tokens';
import { getEmailSignature } from '$lib/server/email-signature';
import { readVapidConfiguration } from '$lib/server/push-notifications';
import { getTwoFactorStatus } from '$lib/server/two-factor';
import { getRecoveryStatus } from '$lib/server/account-recovery';
import { getCleanupSettings } from '$lib/server/cleanup';

export const load: PageServerLoad = async ({ locals, platform }) => {
	const db = platform?.env.DB;
	const signature = locals.user && db ? await getEmailSignature(db, locals.user.id) : '';
	const apiTokens = locals.user && db ? await listApiTokens(db, locals.user.id) : [];
	const vapid = platform?.env ? readVapidConfiguration(platform.env) : null;
	const twoFactor =
		locals.user && db
			? await getTwoFactorStatus(db, locals.user.id)
			: { enabled: false, enabledAt: null, backupCodesRemaining: 0 };
	const recovery =
		locals.user && db
			? await getRecoveryStatus(db, locals.user.id)
			: { email: null, pending: null, verifiedAt: null };
	const cleanup =
		locals.user && db
			? await getCleanupSettings(db, locals.user.id)
			: { trashRetentionDays: 0 };

	return {
		domains: locals.domains,
		addresses: locals.addresses,
		signature,
		apiTokens,
		push: {
			configured: Boolean(vapid),
			publicKey: vapid?.publicKey ?? null
		},
		twoFactor,
		recovery,
		cleanup,
		isAdmin: locals.user?.is_admin ?? false
	};
};
