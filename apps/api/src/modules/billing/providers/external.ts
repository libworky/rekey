/**
 * The outbound half of the external billing provider, which is to say the
 * half that refuses.
 *
 * `getProviderForApplication` has to answer for every registered module,
 * and the code paths that dial a processor (checkout, plan registration,
 * cancellation, refunds) reach it by the name stamped on a row. A
 * subscription activated by an external system carries `provider:
 * 'external'`, so those paths will ask for this. Each answer is a
 * `RekeyError` that names the real repair instead of a TypeError from a
 * missing switch case.
 *
 * Cancellation deserves a word. The money lives in the external system, and
 * cancelling the local row without telling that system would leave the buyer
 * charged for something Rekey no longer grants. So a cancel through Rekey is
 * refused with `SUBSCRIPTION_MANAGED_EXTERNALLY`, and the external system
 * posts `subscription.canceled` when it has actually stopped billing. The two
 * best-effort callers (dunning exhaustion, end-user erasure) already catch
 * a provider error and proceed locally, which is the right outcome for
 * both: erasure must not be blocked by a system Rekey cannot reach, and a
 * subscription the sender has left past due for fourteen days is being
 * cancelled on Rekey's own dunning terms.
 */

import type { Plan } from '@prisma/client';
import { RekeyError } from '../../../lib/error.js';
import type {
  BillingProvider,
  CancelSubscriptionInput,
  CheckoutSessionInput,
  CheckoutSessionResult,
  ProviderPlanRef,
} from './types.js';

export const EXTERNAL_PROVIDER_NAME = 'external';

function inboundOnly(operation: string): RekeyError {
  return new RekeyError({
    statusCode: 400,
    code: 'BILLING_PROVIDER_INBOUND_ONLY',
    message: `The external billing provider cannot perform ${operation}; it only receives events.`,
    fix: 'Do this in your billing system, which then posts the resulting subscription.* event to Rekey. For self-serve checkout, connect Stripe, PayPal or Razorpay.',
  });
}

export class ExternalBillingProvider implements BillingProvider {
  readonly name = EXTERNAL_PROVIDER_NAME;

  async ensurePlanRegistered(_plan: Plan): Promise<ProviderPlanRef> {
    throw inboundOnly('plan registration');
  }

  async createCheckoutSession(_input: CheckoutSessionInput): Promise<CheckoutSessionResult> {
    throw inboundOnly('checkout');
  }

  async createOneTimeCheckout(_input: CheckoutSessionInput): Promise<CheckoutSessionResult> {
    throw inboundOnly('checkout');
  }

  async cancelSubscription(input: CancelSubscriptionInput): Promise<void> {
    throw new RekeyError({
      statusCode: 409,
      code: 'SUBSCRIPTION_MANAGED_EXTERNALLY',
      message: 'This subscription is managed by an external billing system and cannot be cancelled here.',
      fix:
        'Cancel it in the billing system that sold it. Rekey mirrors the change when that system posts ' +
        `subscription.canceled for "${input.subscription.providerSubId ?? input.subscription.id}".`,
    });
  }
}
