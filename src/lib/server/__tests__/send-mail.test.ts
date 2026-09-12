import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { sendOutboundEmail, type OutboundMailInput } from '../send-mail';
import type { EmailProvider, ProviderDomain } from '../email-provider';
import type { MailAddress } from '$lib/types';

const from: MailAddress = {
	id: 'addr_1',
	user_id: 'user_1',
	domain_id: 'dom_1',
	domain_name: 'ourdomain.test',
	address: 'ada@ourdomain.test',
	label: 'Ada',
	is_default: true,
	signature: null,
	created_at: '2026-09-01 10:00:00'
};

/** Captures exactly what the provider was handed. */
function recordingProvider() {
	const calls: OutboundMailInput[] = [];

	const provider: EmailProvider = {
		kind: 'resend',
		async send(input) {
			calls.push(input);
			return { providerId: 'msg_1' };
		},
		async listDomains(): Promise<ProviderDomain[]> {
			return [];
		},
		async getDomain(): Promise<ProviderDomain> {
			throw new Error('not used');
		}
	};

	return { provider, calls };
}

const base = {
	from,
	senderName: 'Ada',
	to: 'grace@example.com',
	subject: 'Quarterly figures',
	text: 'The numbers are attached.'
};

describe('handing a message to the provider', () => {
	// Regression guard: this function rebuilds the payload rather than
	// forwarding its argument, so a new field is dropped unless it is added
	// here too — and an optional field going missing is invisible to tsc.
	test('the recipients and subject survive the rebuild', async () => {
		const { provider, calls } = recordingProvider();

		await sendOutboundEmail(provider, {
			...base,
			to: 'grace@example.com, alan@example.com',
			cc: 'kay@example.com',
			subject: '  Quarterly figures  '
		});

		assert.deepEqual(calls[0].to, ['grace@example.com', 'alan@example.com']);
		assert.deepEqual(calls[0].cc, ['kay@example.com']);
		assert.equal(calls[0].subject, 'Quarterly figures');
	});
});
