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

> **Scope note (added 2026-08-18, SB3-207 task 028).** This rule covers **one of two** state axes —
> `Payment.transactions[].state`. A second axis, `Order.paymentState`, was added by ADR-009 and is
> mapped separately in `ORDER_PAYMENT_STATE_BY_EVENT` (`utils.ts`), with a **different gate**:
> `requires_action` reaches the order axis for **every** payment method, while the table below stays
> bank-transfer-only. Do not unify the two — see `order-payment-state.md` Rule 3 for why the
> asymmetry is deliberate. The invariant below (pure function of the payload, never of prior CT
> state) applies to **this** axis only; the order axis deliberately reads prior CT state to decide
> ownership, which is exactly why it lives in the service and not in the converter.

**What:** Given an event, the converter's output is a pure function of that event's payload. Most event types map to one fixed set of CT transaction types; `payment_intent.requires_action` is the exception — **whether it produces a transaction at all is decided before the converter runs**, by the route, on the payment method carried in the event payload. The mapping in `populateTransactions()` is:

| Stripe Event | CT Transactions Created |
|---|---|
| `payment_intent.succeeded` | CHARGE: SUCCESS |
| `charge.succeeded` | AUTHORIZATION: SUCCESS |
| `payment_intent.canceled` | AUTHORIZATION: FAILURE + CANCEL_AUTHORIZATION: SUCCESS |
| `payment_intent.payment_failed` | AUTHORIZATION: FAILURE |
| `payment_intent.processing` | AUTHORIZATION: PENDING (async settlement; deduped; resolved to SUCCESS on `payment_intent.succeeded` — see Rule 6) |
| `payment_intent.requires_action` | AUTHORIZATION: PENDING for `pi.amount` — **but only for bank transfers**; card 3DS and Boleto emit this same event and never reach the converter. See Rule 6. |
| `payment_intent.partially_funded` | (no CT transaction — converter returns `[]`; the interface interaction is still persisted. See Rule 6.) |
| `customer_cash_balance_transaction.created` | (never converted — the converter rejects it outright. Observability only; see Rule 7.) |
| `charge.refunded` | REFUND: SUCCESS + CHARGE_BACK: SUCCESS |
| `refund.updated` / `refund.failed` | REFUND: FAILURE — only when `status` is `failed` or `canceled`. Does not use the converter. See Rule 7. |
| `charge.updated` (multicapture, multi-ops only) | CHARGE: SUCCESS |

**Why:** CT payment state must reflect the definitive outcome from Stripe.

**Framing correction (2026-08-13, SB3-207):** this rule used to say each event maps to a *fixed* set of transactions and that the mapping "does not depend on current CT state". The second clause still holds and is the invariant below. The first no longer describes reality: `payment_intent.requires_action` yields a Pending authorization for a bank transfer and nothing at all for card 3DS. That is not a weakening of the invariant — the discriminator is `next_action.type`, a field **in the event payload**, not prior commercetools state. Same payload, same output, every time.

**Invariant:** The converter always produces the same output for the same input event. Never conditionally change the transaction type based on prior CT state.

> The invariant above is deliberately unchanged and must not be rewritten when this rule is next edited. Branching on the event payload and branching on prior CT state look similar in a diff and are not the same thing: the first is a pure function of the input, the second makes the converter's output depend on what was written before, which is what breaks replay and redelivery. The dedup guard (Rule 6) *does* read prior CT state — that is why it lives in the service and not in the converter.

**Implementation:** `processor/src/services/converters/stripeEventConverter.ts` → `populateTransactions()`. The router in `processor/src/routes/stripe-payment.route.ts` dispatches each event type to either `processStripeEvent()`, `processStripeEventRefunded()` (multi-ops `charge.refunded`), or `processStripeEventMultipleCaptured()` (multi-ops `charge.updated`).

**Note — unsupported events (general mechanism, still in effect):** The converter's `default` branch throws `Unsupported event …` for any event type with no case, and `processStripeEvent()` swallows that error (KI-001) — so a genuinely unsupported event (e.g. `charge.dispute.created`) produces no CT transaction. This mechanism is unchanged, and it is why a route case must never be added ahead of its converter case: the event would be lost silently behind a 200. See Rule 6, KI-017, and KI-026.

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

---

## Rule 6: Async-settlement events are deduped and never swallowed; `requires_action` is narrowed at the route

> Added for crypto/stablecoin async settlement (ADR-007). **Rewritten 2026-08-13 (SB3-207):** this rule previously stated that `requires_action` never writes a CT transaction. That is now false, and the sentence was load-bearing enough that leaving it would have been worse than having no rule.

**What:** Two events are async-settlement events — `payment_intent.processing` (crypto/stablecoin) and `payment_intent.requires_action` (bank transfer). Both are subscribed, both route to `processStripeEvent()`, and both map to a single `Authorization/Pending`. Membership is declared once, in `ASYNC_PENDING_EVENTS`, and drives three behaviours:

1. **Dedup.** Before writing, `hasTransactionInState()` skips the write if a `Charge/Success` or an `Authorization/Pending` already exists — the synchronous gate may have written the Pending first for non-redirect methods, and Stripe may redeliver.
2. **Scoped no-swallow.** A CT-update failure on these events is **rethrown** (non-2xx → Stripe retries) instead of being swallowed. A deliberate exception to KI-001; all other events keep log-and-return so the card regression is unchanged.
3. **Amount source.** The amount comes from `pi.amount`, never `amount_received`. `amount_received` is `0` for the whole in-flight window, so the settled-amount helper would book a zero-cent authorization — silently, and against a real order.

**`requires_action` is narrowed at the route, not in the converter.** Card 3DS (`use_stripe_sdk`), Boleto (`boleto_display_details`) and redirect-based methods emit the identical event. `isBankTransferNextAction()` — strict equality on `next_action.type === 'display_bank_transfer_instructions'` plus a presence check on the instructions object, failing closed — decides which ones reach `processStripeEvent()` at all. Everything else keeps a log-only path. The converter's case is unconditional on purpose: two gates that must agree will eventually disagree, and the route's is the one with the release-gate tests.

**`payment_intent.partially_funded` is NOT an async-settlement event**, and the exclusion is deliberate rather than an oversight. It writes no transaction — a second `Authorization/Pending` would break the dedup invariant (a three-instalment top-up would book 3× the order value), and a partial `Charge/Success` would recognise revenue that sits in the customer's cash balance rather than on the platform balance. It is not in `ASYNC_PENDING_EVENTS` either: losing it costs an audit line rather than correctness, and rethrowing would cause a retry storm on an event that fires once per instalment. It persists its interface interaction via `ZERO_TRANSACTION_PERSIST_EVENTS` so it still leaves a trace.

**Why:** async settlement must not be lost — if the `Pending` write fails and is swallowed, the payment is stuck with no authorization while Stripe considers the event delivered. Rethrowing lets Stripe retry; the dedup makes that retry safe.

**Invariant:** For every member of `ASYNC_PENDING_EVENTS`: never write a duplicate `Pending`; never swallow a write failure; never take the amount from `amount_received`. For `requires_action` specifically: never write a CT transaction for a payment method other than bank transfer. For `partially_funded`: never write a transaction at all.

**Implementation:** `actions.ts` (`enabled_events`); `stripe-payment.route.ts` (the merged `requires_action`/`partially_funded` case and its predicate); `stripe-payment.service.ts` → `ASYNC_PENDING_EVENTS`, `ZERO_TRANSACTION_PERSIST_EVENTS`, `processStripeEvent()`, `isRedundantAsyncPendingEvent()`; `utils.ts` → `isBankTransferNextAction()`; `stripeEventConverter.ts` (`case PAYMENT_INTENT__REQUIRED_ACTION`, `case PAYMENT_INTENT__PARTIALLY_FUNDED`).

**Closure criterion:** `grep -n 'ASYNC_PENDING_EVENTS' processor/src/services/stripe-payment.service.ts` — both the dedup guard and the rethrow read it. `grep -n 'isBankTransferNextAction' processor/src/routes/stripe-payment.route.ts` — the route narrows before dispatching.

**What breaks if violated:** removing the predicate writes an `Authorization/Pending` to commercetools on **every 3DS card payment**. Reusing the settled-amount helper books zero-cent authorizations. Both fail silently in production and both are held by release-gate tests — including the mirror assertion that a bank transfer *is* routed, without which the predicate could reject everything and the suite would stay green.

---

## Rule 7: Three registered events never reach the converter, each for a different reason

> Added 2026-08-13 (SB3-207).

**What:** `customer_cash_balance_transaction.created`, `refund.updated` and `refund.failed` are registered and handled, but none flows through `StripeEventConverter.convert()`.

1. **`customer_cash_balance_transaction.created` — observability only.** The event object is customer-scoped: it carries no `ct_payment_id`, and deciding which commercetools transaction a reversal should write when the order may already have shipped is a design of its own, deferred past v1. `convert()` **rejects it explicitly** so the invariant is enforced on both sides rather than by the route switch alone. `funding_reversed` and `adjusted_for_overdraft` log at **error** level — they are the only signal that money was withdrawn after the payment was credited, and commercetools is not updated.
   **Never log the event or `event.data.object` here.** The payload carries `sender_name`, `iban_last4`, `account_number_last4` and `sort_code` under `funded.bank_transfer`. The handler builds its log payload field by field for exactly this reason.
2. **`refund.updated` / `refund.failed` — only the failed outcome acts.** `processStripeEventRefundFailed()` builds its own update because a Refund payload has no `ct_payment_id` where `getCtPaymentId()` reads it; it reads the stamp from `refund.metadata` instead. Success outcomes are ignored — `charge.refunded` already writes `Refund/Success`, so acting here too would book the same refund twice. See `refunds-reversals.md` Rule 6.

**Invariant:** `convert()` must never be called for `customer_cash_balance_transaction.created`. A refund event must never write a CT transaction unless its `status` is `failed` or `canceled`.

**Implementation:** `stripe-payment.route.ts` → `logCustomerCashBalanceTransaction()` and the `REFUND__UPDATED`/`REFUND__FAILED` case; `stripe-payment.service.ts` → `processStripeEventRefundFailed()`; `stripeEventConverter.ts` → the guard at the top of `convert()`.

**What breaks if violated:** routing the cash-balance event to the converter throws inside a handler that would otherwise swallow it into a 200. Acting on a succeeded refund double-books the refund.

---

## Rule 8: A foreign PaymentIntent is skipped with a 200, and that is not a KI-001 violation

> Added 2026-08-13 (SB3-207 task 025).

**What:** When the converted event carries no commercetools payment id (`updateData.id` is falsy), `processStripeEvent()` logs a warning and returns before any lookup or write. The webhook answers **200**.

**Why:** the PaymentIntent was not created by this connector — a Dashboard-issued intent, or another integration sharing the Stripe account. Stripe always returns `metadata: {}` on a PaymentIntent, so `getCtPaymentId()` does not throw; it returns `undefined` and `convert()` succeeds. Without the guard the failure surfaced one line later, at `getPayment({ id: undefined })`, and for a member of `ASYNC_PENDING_EVENTS` that throw was rethrown as a 500 that Stripe retries for three days. Sustained 5xx can get the whole webhook endpoint disabled, taking down **every** event and not just this one.

**This resembles the violation KI-001 forbids and is not one.** KI-001 covers answering 200 after a commercetools write **failed**, where a retry would fix it. Here no write is attempted and no retry can ever succeed: the metadata will never appear on a foreign intent. Answering 5xx buys three days of pointless retries and risks the endpoint. The level is `warn`, not `error` — a foreign event is another integration's traffic, not a fault of ours.

**Invariant:** never issue a commercetools lookup or write for an event whose `ct_payment_id` is absent. The guard must sit **before** the dedup lookup, not after.

**Implementation:** `stripe-payment.service.ts` → `processStripeEvent()`, immediately after `convert()`. Scoped to `processStripeEvent` on purpose: `processStripeEventRefunded()` and `processStripeEventMultipleCaptured()` also convert, but both swallow their errors, so the same payload costs them a logged error rather than a retry storm.

**Closure criterion:** `grep -n 'carries no commercetools payment id' processor/src/services/stripe-payment.service.ts`.

**What breaks if violated:** a foreign PaymentIntent turns into a 500 that Stripe retries for three days, and sustained 5xx can get the webhook endpoint disabled — taking down every event for every payment.

---

## Rule 9: The `pspInteraction` payload is redacted before it is persisted, and the redaction fails closed

> Documented 2026-08-25. The code landed with SB3-207; it had no entry in `context/` until this pass, which is exactly the gap this rule exists to prevent.

**What:** `buildPspInteractionResponse()` sanitizes the event before serializing it into the interface interaction. Two paths. A **Charge**-shaped payload is serialized byte-identically — a Charge has neither `next_action` nor `client_secret`, so there is nothing to do. **Every other shape** is deep-cloned, has its `next_action` passed through an **allowlist** (`sanitizeNextAction`), and has `client_secret` nulled unconditionally.

**Why:** commercetools interface interactions are **append-only and readable by every Merchant Center user with payment read access**. They cannot be redacted after the fact. On the bank transfer rail the raw payload carries the merchant's full IBAN, sort code and routing number (`display_bank_transfer_instructions.financial_addresses`), unauthenticated customer-facing `hosted_*_url` links, and — least obviously — `redirect_to_url.url`, which embeds a **live** `payment_intent_client_secret` as a query parameter. Nulling the PaymentIntent's own `client_secret` without deleting that URL would leave a second working copy of the same credential alive through a different channel, for the whole multi-day funding window.

**The polarity of the Charge check is the load-bearing part, not the redaction itself.** The early return fires only on the one shape *positively known* to be safe, and lets every other shape fall through to redaction. Written as `!== 'payment_intent'` it would read equivalently today and fail **open** tomorrow: `SetupIntent` and `Refund` also carry `next_action`, and `SetupIntent.next_action.redirect_to_url.url` embeds a live `setup_intent_client_secret` exactly as the PaymentIntent variant does. Since `setup_future_usage` and recurring are live in this connector, someone adding `setup_intent.*` to the dispatcher is plausible — and with the inverted guard that addition would be handed through unsanitized, silently, with no test going red.

**Three further constraints that look like style and are not.** The **deep clone** is required: `event` is read again *after* `convert()` returns, by `applyMulticaptureAdjustment` and by the route's logger, so redacting in place corrupts those reads. The method is **private** on purpose: the converter is the only thing that builds `pspInteraction` and all three `convert()` call sites flow through it, so a private method is a choke point that cannot be bypassed — a public helper inverts the failure mode to "someone adds a persistence path and forgets to call it". And the allowlist **deletes** `hosted_instructions_url` rather than nulling it, diverging from the first version of this method deliberately: an absent key is a stronger signal to a reader than a null one.

**This record is NOT PII-free, and must not be described as such.** Only `data.object.next_action` is sanitized. `data.previous_attributes` (populated on `*.updated` events) is untouched. The Charge side is untouched: `payment_method_details.ach_credit_transfer.{account_number,routing_number}` and `sepa_credit_transfer.iban` carry full **payer** account numbers, arrive on `charge.succeeded`, and are persisted today — harmless only because this connector configures `customer_balance` exclusively, whose `PaymentMethodDetails` is an empty object. Customer `billing_details`, `shipping` and `receipt_email` are persisted verbatim.

**Invariant:** no payload shape other than Charge may reach `JSON.stringify` unsanitized, and the Charge exemption must stay expressed as a positive match on `'charge'`. A newly dispatched event type is redacted by default; opting a shape out is a deliberate act with a stated reason.

**Implementation:** `processor/src/services/converters/stripeEventConverter.ts` → `buildPspInteractionResponse()`, `sanitizeNextAction()`.

**Closure criterion:** `grep -n "dataObject?.object === 'charge'" processor/src/services/converters/stripeEventConverter.ts` — the guard must be a positive equality on `'charge'`, never a negation on `'payment_intent'`.

**What breaks if violated:** a live `client_secret`, the merchant's full IBAN and unauthenticated hosted links are written into an append-only commercetools record that cannot be cleaned up, readable by any Merchant Center user with payment read access, for the entire multi-day funding window of the transfer.
