# Business Rule: Webhook Handling

## Overview

Stripe webhooks are the mechanism by which asynchronous payment outcomes (charge success, refund, cancellation) are reflected in CT. The processor must process them reliably and idempotently.

---

## Rule 1: Webhook signature must be verified before any processing

**What:** Every POST to `/stripe/webhooks` is verified using `stripe.webhooks.constructEvent()` with `STRIPE_WEBHOOK_SIGNING_SECRET` inside the route handler. The `StripeHeaderAuthHook` pre-handler runs first but only confirms that the `stripe-signature` header is present — it does not validate the signature itself.

**Why:** Anyone can POST to a public webhook endpoint. Without signature verification, a malicious actor could send fake events to manipulate CT payment states.

**Invariant:** If signature verification fails inside the handler, the request is rejected immediately with 400 and no event is processed.

**Implementation:**

- Header presence check: `processor/src/libs/fastify/hooks/stripe-header-auth.hook.ts` → `StripeHeaderAuthHook.authenticate()`
- Cryptographic verification: `processor/src/routes/stripe-payment.route.ts` → `stripeWebhooksRoutes` handler — calls `stripeApi().webhooks.constructEvent(rawBody, signature, stripeWebhookSigningSecret)` and returns 400 on failure.

**What breaks if violated:** Fraudulent webhook events could mark unpaid orders as paid, trigger refunds on valid payments, or cancel active authorizations.

---

## Rule 2: Webhooks are processed synchronously, then 200 is returned

**What:** The webhook handler does not respond 200 early. After signature verification, all CT update work for the event runs to completion (`await`-ed) and only then is the 200 response sent.

**Why:** Returning 200 only after processing means CT updates that fail (or throw) are still observable as a non-2xx response, which causes Stripe to retry. The trade-off is that slow processing can push Stripe close to its delivery timeout and trigger retries.

**Invariant:** Processing happens within the request lifecycle. There is no queue or background job. If a handler throws before reaching `reply.status(200).send()`, Fastify returns 5xx and Stripe will retry.

**Implementation:** `processor/src/routes/stripe-payment.route.ts` → `stripeWebhooksRoutes` handler — `await opts.paymentService.processStripeEvent(event)` (and friends) runs first, `reply.status(200).send()` is the final statement.

**Note — limitation:** Several other docs and ADRs claim that 200 is sent "immediately" before processing. That is the documented intent for resilient webhook handling but is not how the current code behaves. Migrating to early-ack would require a background queue/worker; today, slow CT updates can result in Stripe retries and therefore duplicate processing.

**What breaks if violated:** If processing throws or hangs, Stripe will retry the event. CT transaction creation is not natively idempotent (see Rule 5 for the payment-method exception), so retries can produce duplicate transactions on the CT Payment.

---

## Rule 3: Event-to-transaction mapping is deterministic

**What:** Each Stripe event type maps to a fixed set of CT transaction types and states. The actual mapping in `populateTransactions()` is:

| Stripe Event | CT Transactions Created |
|---|---|
| `payment_intent.succeeded` | CHARGE: SUCCESS |
| `charge.succeeded` | AUTHORIZATION: SUCCESS |
| `payment_intent.canceled` | AUTHORIZATION: FAILURE + CANCEL_AUTHORIZATION: SUCCESS |
| `payment_intent.payment_failed` | AUTHORIZATION: FAILURE |
| `payment_intent.requires_action` | (no case in converter — the dispatcher routes the event to `processStripeEvent()` which calls the converter; the converter `default` branch throws and the error is caught/logged in `processStripeEvent`. No CT transaction is created.) |
| `charge.refunded` | REFUND: SUCCESS + CHARGE_BACK: SUCCESS |
| `charge.updated` (multicapture, multi-ops only) | CHARGE: SUCCESS |

**Why:** CT payment state must reflect the definitive outcome from Stripe. The mapping is fixed — it does not depend on current CT state.

**Invariant:** The converter always produces the same output for the same input event. Never conditionally change the transaction type based on prior CT state.

**Implementation:** `processor/src/services/converters/stripeEventConverter.ts` → `populateTransactions()`. The router in `processor/src/routes/stripe-payment.route.ts` dispatches each event type to either `processStripeEvent()`, `processStripeEventRefunded()` (multi-ops `charge.refunded`), or `processStripeEventMultipleCaptured()` (multi-ops `charge.updated`).

**Note — limitation (`payment_intent.requires_action`):** The webhook dispatcher routes this event to `processStripeEvent()` even though the converter has no case for it. The converter throws `Unsupported event payment_intent.requires_action`, the error is swallowed by `processStripeEvent`'s try/catch, and CT is left unchanged. To map this event to a real CT transaction, add a case to `populateTransactions()` in `stripeEventConverter.ts`.

**Note — limitation (`payment_intent.succeeded`):** The converter currently emits a `CHARGE: SUCCESS` transaction for `payment_intent.succeeded`, which conflates the "intent succeeded" event with a captured charge. The pairing of `charge.succeeded` → AUTHORIZATION:SUCCESS and `payment_intent.succeeded` → CHARGE:SUCCESS appears intentional for `automatic` capture mode (where both events arrive and together encode auth + capture), but it is brittle for `manual` capture and worth revisiting. Tracked location: `stripeEventConverter.ts` `case StripeEvent.PAYMENT_INTENT__SUCCEEDED`.

**What breaks if violated:** CT and Stripe states diverge. Orders may appear paid when they are not, or appear pending when they are settled.

---

## Rule 4: `charge.refunded` uses enhanced processing when multi-operations is enabled

**What:** When `STRIPE_ENABLE_MULTI_OPERATIONS=true`, `charge.refunded` is handled by `processStripeEventRefunded()`, which calls `stripe.refunds.list({ charge, created: { gte: charge.created }, limit: 2 })` and uses the most recent refund's `id`/`amount`/`currency` to populate the CT transaction. When disabled, it uses the standard `processStripeEvent()` which derives the amount from `charge.amount_refunded` (cumulative).

**Why:** With multicapture/multirefund, there may be multiple partial refunds. The cumulative `amount_refunded` field on the charge would overstate per-refund transactions, so the enhanced handler narrows to a specific refund object.

**Invariant:** When multi-operations is enabled, always use the enhanced refund handler. Never use the cumulative `amount_refunded` field for individual refund transactions.

**Implementation:** `processor/src/routes/stripe-payment.route.ts` (dispatcher branch on `stripeEnableMultiOperations`) and `processor/src/services/stripe-payment.service.ts` → `processStripeEventRefunded()` vs `processStripeEvent()`.

**What breaks if violated:** CT records incorrect refund amounts when multiple partial refunds exist on a single charge.

---

## Rule 5: Payment method storage from webhooks is idempotent

**What:** On `payment_intent.succeeded` and `charge.succeeded`, the dispatcher calls `storePaymentMethod(event)` after `processStripeEvent(event)`. Before saving, it checks if a token with that value already exists in CT for the same customer + payment interface.

**Why:** Stripe may deliver the same event more than once (at-least-once delivery). Duplicate payment method storage would create duplicate records in CT.

**Invariant:** Always check `ctPaymentMethodService.getByTokenValue({ customerId, paymentInterface, tokenValue })` before calling `ctPaymentMethodService.save()`. If the token exists, return the existing record and skip the save.

**Implementation:** `processor/src/services/stripe-payment.service.ts` → `savePaymentMethodIfNew()` (called from `storePaymentMethod()`). The dispatcher in `processor/src/routes/stripe-payment.route.ts` calls `storePaymentMethod` for both `payment_intent.succeeded` and `charge.succeeded`.

**What breaks if violated:** Duplicate payment method tokens in CT. The customer would see the same card listed multiple times in their saved payment methods.
