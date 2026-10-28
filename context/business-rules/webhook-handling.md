# Webhook Handling

How the processor accepts Stripe webhooks and turns them into commercetools Payment transactions.
Order state is in `order-payment-state.md`.

Stripe webhooks are the mechanism by which asynchronous payment outcomes (charge success, refund,
cancellation) are reflected in CT.

---

## Rule 1: Webhook signature must be verified before any processing

**What:** Every POST to `/stripe/webhooks` is verified using `stripe.webhooks.constructEvent()` with `STRIPE_WEBHOOK_SIGNING_SECRET` inside the route handler. The `StripeHeaderAuthHook` pre-handler runs first and confirms that the `stripe-signature` header is present; the cryptographic verification is in the route handler.

**Invariant:** If signature verification fails inside the handler, the request is rejected immediately with 400 and no event is processed — no `switch (event.type)` branch is reachable without a successful `constructEvent`.

**Implementation:**

- Header presence check: `processor/src/libs/fastify/hooks/stripe-header-auth.hook.ts:4-13` → `StripeHeaderAuthHook.authenticate()` (the check is `:7`)
- Cryptographic verification: `processor/src/routes/stripe-payment.route.ts:207-255` → `stripeWebhooksRoutes` handler — calls `stripeApi().webhooks.constructEvent(rawBody, signature, stripeWebhookSigningSecret)` (`:219-224`) and returns 400 on failure (`:254`). The failure log carries `errorType` and `errorMessage` only, never the error object.

---

## Rule 2: Webhooks are processed synchronously, then 200 is returned

**What:** The webhook handler does not respond 200 early. After signature verification, all CT update work for the event is `await`-ed to completion, and only then is the 200 response sent.

**Invariant:** Processing happens within the request lifecycle. There is no queue or background job.

**Implementation:** `processor/src/routes/stripe-payment.route.ts:257-385` → `stripeWebhooksRoutes` handler — `await opts.paymentService.processStripeEvent(event)` (and friends) runs first, `reply.status(200).send()` is the final statement (`:385`).

---

## Rule 3: Event-to-transaction mapping is deterministic

> **Scope note.** This rule covers **one of two** state axes — `Payment.transactions[].state`. A second
> axis, `Order.paymentState`, is mapped separately in `ORDER_PAYMENT_STATE_BY_EVENT` (`utils.ts`), with a
> **different gate**: `requires_action` reaches the order axis for **every** payment method, while the
> table below stays bank-transfer-only. See `order-payment-state.md` Rule 3. The invariant below applies
> to **this** axis only; the order axis reads prior CT state to decide ownership, which is why it lives in
> the service and not in the converter.

**What:** Given an event, the converter's output is a pure function of that event's payload. Most event types map to one fixed set of CT transaction types; `payment_intent.requires_action` is the exception — **whether it produces a transaction at all is decided before the converter runs**, by the route, on the payment method carried in the event payload. The mapping in `populateTransactions()` is:

| Stripe Event | CT Transactions Created |
|---|---|
| `payment_intent.succeeded` | CHARGE: SUCCESS |
| `charge.succeeded` | AUTHORIZATION: SUCCESS |
| `payment_intent.canceled` | AUTHORIZATION: FAILURE + CANCEL_AUTHORIZATION: SUCCESS |
| `payment_intent.payment_failed` | AUTHORIZATION: FAILURE |
| `payment_intent.processing` | AUTHORIZATION: PENDING (async settlement; deduped; resolved to SUCCESS on `payment_intent.succeeded` — see Rules 6 and 10) |
| `payment_intent.requires_action` | AUTHORIZATION: PENDING for `pi.amount` — **but only for bank transfers**; card 3DS, Boleto and ACH microdeposits (`verify_with_microdeposits`) emit this same event and never reach the converter. See Rule 6. |
| `payment_intent.partially_funded` | (no CT transaction — converter returns `[]`. See Rule 6.) |
| `customer_cash_balance_transaction.created` | (never converted — the converter rejects it outright. Observability only; see Rule 7.) |
| `charge.refunded` | REFUND: SUCCESS + CHARGE_BACK: SUCCESS |
| `refund.updated` / `refund.failed` | REFUND: FAILURE — only when `status` is `failed` or `canceled`. Does not use the converter. See Rule 7. |
| `charge.updated` (multicapture, multi-ops only) | CHARGE: SUCCESS |

**Why:** CT payment state must reflect the definitive outcome from Stripe. The discriminator for `payment_intent.requires_action` is `next_action.type`, a field **in the event payload**, not prior commercetools state.

**Invariant:** The converter always produces the same output for the same input event. Never conditionally change the transaction type based on prior CT state.

**Implementation:** `processor/src/services/converters/stripeEventConverter.ts:263-386` → `populateTransactions()`. The router in `processor/src/routes/stripe-payment.route.ts:257-383` dispatches each event type to either `processStripeEvent()`, `processStripeEventRefunded()` (multi-ops `charge.refunded`), or `processStripeEventMultipleCaptured()` (multi-ops `charge.updated`).

---

## Rule 4: `charge.refunded` uses enhanced processing when multi-operations is enabled

**What:** When `STRIPE_ENABLE_MULTI_OPERATIONS=true`, `charge.refunded` is handled by `processStripeEventRefunded()`, which calls `stripe.refunds.list({ charge, created: { gte: charge.created }, limit: 2 })` and uses the most recent refund's `id`/`amount`/`currency` to populate the CT transaction. When disabled, it uses the standard `processStripeEvent()` which derives the amount from `charge.amount_refunded` (cumulative).

**Why:** With multicapture/multirefund, there may be multiple partial refunds, so the enhanced handler narrows to a specific refund object.

**Invariant:** When multi-operations is enabled, always use the enhanced refund handler. Never use the cumulative `amount_refunded` field for individual refund transactions.

**Implementation:** `processor/src/routes/stripe-payment.route.ts:363-371` (dispatcher branch on `stripeEnableMultiOperations`) and `processor/src/services/stripe-payment.service.ts:2741-2796` → `processStripeEventRefunded()` (refund lookup `:2746-2752`, per-refund amount `:2760-2767`) vs `processStripeEvent()`.

> Same invariant, seen from the refund side: `multi-operations.md` Rule 4.

---

## Rule 5: Payment method storage from webhooks is idempotent

**What:** On `payment_intent.succeeded` and `charge.succeeded`, the dispatcher calls `storePaymentMethod(event)` after `processStripeEvent(event)`. Before saving, it checks if a token with that value already exists in CT for the same customer + payment interface.

**Why:** Stripe may deliver the same event more than once (at-least-once delivery).

**Invariant:** Always check `ctPaymentMethodService.getByTokenValue({ customerId, paymentInterface, tokenValue })` before calling `ctPaymentMethodService.save()`. If the token exists, return the existing record and skip the save.

**Implementation:** `processor/src/services/stripe-payment.service.ts:3726-3769` → `savePaymentMethodIfNew()` (lookup `:3731-3743`, save `:3755-3760`; an `ErrorResourceNotFound` from the lookup means "absent", any other error is rethrown), called from `storePaymentMethod()` (`:2606-2660`). The dispatcher in `processor/src/routes/stripe-payment.route.ts:271` calls `storePaymentMethod` for both `payment_intent.succeeded` and `charge.succeeded`. It skips when the event carries no `ct_customer_id` or the Stripe method has no customer (`:2611-2626`).

---

## Rule 6: Async-settlement events are deduped; `requires_action` is narrowed at the route

**What:** Two events are async-settlement events — `payment_intent.processing` (crypto/stablecoin) and `payment_intent.requires_action` (bank transfer). Both are subscribed, both route to `processStripeEvent()`, and both map to a single `Authorization/Pending`. Membership is declared once, in `ASYNC_PENDING_EVENTS`, and drives three behaviours:

1. **Dedup.** Before writing, `hasTransactionInState()` skips the write if a `Charge/Success` or an `Authorization/Pending` already exists — the synchronous gate may have written the Pending first for non-redirect methods, and Stripe may redeliver. The confirm gate applies the same check before its own Pending write, so **both** writers of `Authorization/Pending` dedup.
2. **Scoped rethrow.** A CT-update failure on these events is **rethrown** (non-2xx → Stripe retries).
3. **Amount source.** The amount comes from `pi.amount`, never `amount_received` (`amount_received` is `0` for the whole in-flight window).

**`requires_action` is narrowed at the route, not in the converter.** Card 3DS (`use_stripe_sdk`), Boleto (`boleto_display_details`), ACH microdeposits (`verify_with_microdeposits`) and redirect-based methods emit the identical event. `isBankTransferNextAction()` — strict equality on `next_action.type === 'display_bank_transfer_instructions'` plus a presence check on the instructions object — decides which ones reach `processStripeEvent()` at all. Everything else keeps a log-only path. The converter's case is unconditional.

**`payment_intent.partially_funded` is NOT an async-settlement event**, and the exclusion is deliberate. It writes no transaction — an `Authorization/Pending` carries the PaymentIntent id as `interactionId`, so the SDK matches it to the authorization already there and at most moves its state, and a partial `Charge/Success` would recognise revenue that sits in the customer's cash balance rather than on the platform balance. It is not in `ASYNC_PENDING_EVENTS`.

**Why:** async settlement must not be lost. Rethrowing lets Stripe retry; the dedup makes that retry safe.

**Invariant:** For every member of `ASYNC_PENDING_EVENTS`: never write a duplicate `Pending`; the `catch` of `processStripeEvent` rethrows exactly when the event type is a member; never take the amount from `amount_received`. For `requires_action` specifically: never write a CT transaction for a payment method other than bank transfer. For `partially_funded`: never write a transaction at all.

**Implementation:** `processor/src/connectors/actions.ts:65-86` (`enabled_events`); `processor/src/routes/stripe-payment.route.ts:280-331` (the merged `requires_action`/`partially_funded` case and its predicate, `:324-329`); `processor/src/services/stripe-payment.service.ts` → `ASYNC_PENDING_EVENTS` (`:84-87`), `ZERO_TRANSACTION_PERSIST_EVENTS` (`:98`), `processStripeEvent()` (dedup `:2040-2045`, zero-transaction persist `:2047-2065`, rethrow `:2117-2119`), `isRedundantAsyncPendingEvent()` (`:2134-2157`), confirm-side dedup `writeAsyncSettlementPendingAuthorization()` (`:1755-1780`); `processor/src/utils.ts:84-87` → `isBankTransferNextAction()`; `processor/src/services/converters/stripeEventConverter.ts` (`case PAYMENT_INTENT__PROCESSING` `:289-301`, `case PAYMENT_INTENT__REQUIRED_ACTION` `:303-327`, `case PAYMENT_INTENT__PARTIALLY_FUNDED` `:328-336`).

---

## Rule 7: Three registered events never reach the converter, each for a different reason

**What:** `customer_cash_balance_transaction.created`, `refund.updated` and `refund.failed` are registered and handled, but none flows through `StripeEventConverter.convert()`.

1. **`customer_cash_balance_transaction.created` — observability only.** The event object is customer-scoped: it carries no `ct_payment_id`, and handling such a reversal is deferred past v1. `convert()` **rejects it explicitly**. `funding_reversed` and `adjusted_for_overdraft` log at **error** level.
2. **`refund.updated` / `refund.failed` — only the failed outcome acts.** `processStripeEventRefundFailed()` builds its own update because a Refund payload has no `ct_payment_id` where `getCtPaymentId()` reads it; it reads the stamp from `refund.metadata` instead. Success outcomes are ignored — `charge.refunded` already writes `Refund/Success`, so acting here too would book the same refund twice. See `refunds-reversals.md` Rule 6.

**Why:** none of the three payloads can be mapped by the converter: the cash-balance event is customer-scoped and carries no `ct_payment_id`, and a Refund carries its stamp in `refund.metadata`, where `getCtPaymentId()` does not look. Success outcomes of refunds are already owned by `charge.refunded`.

**Invariant:** `convert()` must never be called for `customer_cash_balance_transaction.created` (its route case calls only `logCustomerCashBalanceTransaction`). A refund event must never write a CT transaction unless its `status` is `failed` or `canceled` (`processStripeEventRefundFailed` is called only then).

**Implementation:** `processor/src/routes/stripe-payment.route.ts:179-205` → `logCustomerCashBalanceTransaction()` (error level `:200-202`), its case `:332-334`, and the `REFUND__UPDATED`/`REFUND__FAILED` case `:335-362` (status gate `:355`); `processor/src/services/stripe-payment.service.ts:2682-2739` → `processStripeEventRefundFailed()`; `processor/src/services/converters/stripeEventConverter.ts:30-32` → the guard at the top of `convert()`.

---

## Rule 8: A foreign PaymentIntent is skipped with a 200

**What:** When the converted event carries no commercetools payment id (`updateData.id` is falsy), `processStripeEvent()` logs a warning and returns before any lookup or write. The webhook answers **200**.

**Why:** the PaymentIntent was not created by this connector — a Dashboard-issued intent, or another integration sharing the Stripe account. Stripe returns `metadata: {}` on such a PaymentIntent, so `getCtPaymentId()` returns `undefined` and `convert()` succeeds. The event is logged at `warn`.

**Invariant:** never issue a commercetools lookup or write for an event whose `ct_payment_id` is absent. The guard must sit **before** the dedup lookup, not after.

**Implementation:** `processor/src/services/stripe-payment.service.ts:2026-2032` → `processStripeEvent()`, immediately after `convert()` (`:2003`) and before the dedup (`:2040`). The order reflection applies the same guard on its own path (`:2284-2290`).

---

## Rule 10: `payment_intent.succeeded` promotes a lingering pending authorization, best-effort

**What:** after the `payment_intent.succeeded` write loop, an `Authorization/Pending` on the payment is transitioned to `Authorization/Success`. This step is best-effort: a failure is logged at warn and does not block the payment flow.

**Why:** async settlement (Rule 6) writes a pending authorization that would otherwise stay pending after the money arrives (`processor/src/services/stripe-payment.service.ts:2192-2197`). It is best-effort so a failure never blocks the successful-payment flow. This is also why the order reflection must read ownership **before** `processStripeEvent` runs (`order-payment-state.md` Rule 8).

**Invariant:** `transitionPendingAuthorizationToSuccess` runs for every `payment_intent.succeeded` that reached the end of the write loop, and is a no-op when no `Authorization/Pending` exists (card).

**Implementation:** `processor/src/services/stripe-payment.service.ts:2085-2087` (call) and `:2198-2228` (method).
