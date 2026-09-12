import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
	MAX_ATTACHMENT_BYTES,
	MAX_ATTACHMENTS_PER_EMAIL,
	MAX_TOTAL_ATTACHMENT_BYTES
} from '$lib/constants';
import type { OutboundAttachmentInput } from '$lib/types';
import { assertOutboundAttachments, assertTotalAttachmentBytes } from '../outbound/outbox';

/**
 * These limits used to live only in the composer, which meant an API token
 * posting straight to `/api/mail` was not held to any of them. Each test here
 * is one of the ways that could be abused.
 */
function attachment(bytes: number, filename = 'file.bin'): OutboundAttachmentInput {
	// Four base64 characters encode three bytes.
	const base64Length = Math.ceil(bytes / 3) * 4;
	return { filename, type: 'application/octet-stream', content: 'A'.repeat(base64Length) };
}

describe('outbound attachment limits', () => {
	test('an ordinary set passes', () => {
		assert.doesNotThrow(() => assertOutboundAttachments([attachment(1024), attachment(2048)]));
	});

	test('no attachments at all is fine', () => {
		assert.doesNotThrow(() => assertOutboundAttachments([]));
	});

	test('more files than the per-email limit is refused', () => {
		const many = Array.from({ length: MAX_ATTACHMENTS_PER_EMAIL + 1 }, (_, index) =>
			attachment(16, `file-${index}.bin`)
		);
		assert.throws(() => assertOutboundAttachments(many), /Maximum 5 attachments/);
	});

	test('exactly the per-email limit is allowed', () => {
		const exact = Array.from({ length: MAX_ATTACHMENTS_PER_EMAIL }, (_, index) =>
			attachment(16, `file-${index}.bin`)
		);
		assert.doesNotThrow(() => assertOutboundAttachments(exact));
	});

	test('a single oversized file is refused, and named', () => {
		assert.throws(
			() => assertOutboundAttachments([attachment(MAX_ATTACHMENT_BYTES + 1024, 'huge.pdf')]),
			/"huge\.pdf" exceeds 5MB limit/
		);
	});

	test('files that are each fine but too much together are refused', () => {
		// Six files a shade under the per-file cap, over the total — and allowed
		// past the count check the way a forwarded thread would be.
		const each = MAX_ATTACHMENT_BYTES - 1024;
		const spread = Array.from({ length: 6 }, (_, index) =>
			attachment(each, `part-${index}.bin`)
		);
		assert.ok(spread.length * each > MAX_TOTAL_ATTACHMENT_BYTES);
		assert.throws(() => assertOutboundAttachments(spread, true), /exceed the total size limit/);
	});

	test('forward-all may exceed the count, but not the total', () => {
		const combined = Array.from({ length: MAX_ATTACHMENTS_PER_EMAIL + 3 }, (_, index) =>
			attachment(1024, `from-thread-${index}.bin`)
		);
		assert.throws(() => assertOutboundAttachments(combined), /Maximum 5 attachments/);
		assert.doesNotThrow(() => assertOutboundAttachments(combined, true));
	});

	test('the total check stands on its own', () => {
		assert.doesNotThrow(() => assertTotalAttachmentBytes(MAX_TOTAL_ATTACHMENT_BYTES));
		assert.throws(
			() => assertTotalAttachmentBytes(MAX_TOTAL_ATTACHMENT_BYTES + 1),
			/exceed the total size limit/
		);
	});
});
