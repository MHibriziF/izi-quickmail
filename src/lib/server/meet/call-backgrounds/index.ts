import { createD1CallBackgroundsRepository } from './repository';
import { createCallBackgroundsService, type CallBackgroundsService } from './service';

export type { CallBackgroundMeta, StoredCallBackground, CallBackgroundsRepository } from './repository';
export { createCallBackgroundsService, type CallBackgroundsService } from './service';

type PlatformLike = App.Platform | undefined | null;

/** Composition root for routes — mirrors `getMeetingsService` in `../meetings`. */
export function getCallBackgroundsService(platform: PlatformLike): CallBackgroundsService {
	const db = platform?.env.DB;
	if (!db) throw new Error('Database unavailable');
	return createCallBackgroundsService({
		repo: createD1CallBackgroundsRepository(db, () => {
			const bucket = platform?.env.ATTACHMENTS;
			if (!bucket) throw new Error('Storage unavailable');
			return bucket;
		})
	});
}
