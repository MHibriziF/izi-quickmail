import { createD1ApiTokenRepository, API_SCOPES, isApiScope } from './repository';
import { createApiTokenService, type ApiTokenService } from './service';

export type { ApiTokenRepository, ApiScope } from './repository';
export { API_SCOPES, isApiScope };
export {
	createApiTokenService,
	isValidScope,
	parseScopes,
	previewFor,
	readBearerToken,
	type ApiTokenService,
	type ApiTokenAuth,
	type CreatedApiToken
} from './service';

type PlatformLike = App.Platform | undefined | null;

/** Composition root for routes — mirrors `getAuthService`/`getDomainsService`. */
export function getApiTokenService(platform: PlatformLike): ApiTokenService {
	const db = platform?.env.DB;
	if (!db) throw new Error('Database unavailable');
	return createApiTokenService(createD1ApiTokenRepository(db));
}
