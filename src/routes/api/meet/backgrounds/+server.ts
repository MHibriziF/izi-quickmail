import { json, type RequestHandler } from '@sveltejs/kit';
import { insertCallBackground, listCallBackgrounds } from '$lib/server/meet/call-backgrounds';

export const GET: RequestHandler = async ({ locals, platform }) => {
	if (!locals.user || !platform?.env.DB) return json({ error: 'Unauthorized' }, { status: 401 });

	const backgrounds = await listCallBackgrounds(platform.env.DB, locals.user.id);
	return json({
		backgrounds: backgrounds.map((background) => ({
			id: background.id,
			contentType: background.content_type,
			sizeBytes: background.size_bytes,
			createdAt: background.created_at,
			url: `/api/meet/backgrounds/${background.id}`
		}))
	});
};

/** Saves an uploaded background image to the caller's gallery. Guests (no account) aren't offered this — nothing to persist against. */
export const POST: RequestHandler = async ({ locals, request, platform }) => {
	if (!locals.user || !platform?.env.DB || !platform?.env.ATTACHMENTS) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	let form: FormData;
	try {
		form = await request.formData();
	} catch {
		return json({ error: 'Invalid request' }, { status: 400 });
	}

	const file = form.get('file');
	if (!(file instanceof File)) {
		return json({ error: 'Missing file' }, { status: 400 });
	}

	try {
		const bytes = new Uint8Array(await file.arrayBuffer());
		const background = await insertCallBackground(platform.env.DB, platform.env.ATTACHMENTS, locals.user.id, {
			filename: file.name,
			type: file.type || 'image/jpeg',
			bytes
		});

		return json({
			id: background.id,
			contentType: background.content_type,
			sizeBytes: background.size_bytes,
			createdAt: background.created_at,
			url: `/api/meet/backgrounds/${background.id}`
		});
	} catch (error) {
		return json({ error: error instanceof Error ? error.message : 'Upload failed' }, { status: 400 });
	}
};
