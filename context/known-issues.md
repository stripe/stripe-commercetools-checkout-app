# Known Issues — ct-connect-stripe-checkout

Connector-specific limitations, code defects, and operational gotchas. Cross-cutting issues (webhook swallow, idempotency, CORS, credential defaults) are also documented in the hub `context/known-issues.md` — cross-references are noted below.

---

## KI-001: Webhook event handlers swallow all errors → HTTP 200 on CT update failure → permanent state divergence

**Problem:** `processStripeEvent()`, `processStripeEventRefunded()`, `processStripeEventMultipleCaptured()`, and `storePaymentMethod()` each contain a top-level try/catch that logs the exception and returns void. The route handler then returns HTTP 200 to Stripe, which considers the event delivered and never retries. The CT payment object is left in an inconsistent state with no automatic recovery.
**Root cause:** `processor/src/services/stripe-payment.service.ts:984` (`processStripeEvent()`), `:1107` (`processStripeEventRefunded()`), `:1155` (`processStripeEventMultipleCaptured()`), `:1051` (`storePaymentMethod()`) — all event processing functions absorb exceptions before they can bubble to the route layer.
**Rule:** Webhook handlers must return HTTP 5xx when CT update fails so Stripe retries. See hub `known-issues.md` Issue 1.
**Implementation note:** Affected events: `charge.succeeded`, `charge.updated`, `charge.refunded`, `payment_intent.succeeded`, `payment_intent.canceled`, `payment_intent.payment_failed`. All of these still swallow the error and return 200. See KI-026.

**Three scoped exceptions, all deliberate (updated 2026-08-13, SB3-207):**
1. `payment_intent.processing` **and** `payment_intent.requires_action` — the members of `ASYNC_PENDING_EVENTS` — are scoped OUT of the swallow. `processStripeEvent()` rethrows on failure so Stripe retries; async settlement must not be lost.
2. `processStripeEventRefundFailed()` rethrows for the same reason: answering 200 after failing to write a refund correction stops Stripe redelivering it, and the payment keeps claiming a refund that never happened.
3. **The one exception that answers 200 on purpose** — a PaymentIntent carrying no `ct_payment_id` is skipped with a warning and a 200. It looks like the violation this entry describes and is not one: no write was attempted, and no retry can ever succeed because the metadata will never appear on an intent this connector did not create. Answering 5xx there buys three days of pointless retries and risks the endpoint being disabled. See `business-rules/webhook-handling.md` Rule 8 before "fixing" it.

---

## KI-002: capturePayment/cancelPayment/refundPayment catch Stripe errors and return REJECTED with no CT state update

**Problem:** `capturePayment()`, `cancelPayment()`, and `refundPayment()` each have a try/catch that catches Stripe API errors and returns `{ outcome: 'REJECTED' }` with HTTP 200. When Stripe rejects the operation, no CT Payment transaction is written and the CT payment state is not updated to reflect the failure.
**Root cause:** `processor/src/services/stripe-payment.service.ts:233` (`capturePayment()`), `:261` (`cancelPayment()`), `:319` (`refundPayment()`) — error is caught, logged, and converted to REJECTED outcome without updating CT.
**Rule:** After a Stripe operation failure, the CT payment must be updated to a FAILED state before returning. See hub `failure-modes.md — Stripe API: Payment Intent operations`.
**Implementation note:** The operator dashboard shows REJECTED with no Stripe error details. CT/Stripe divergence requires manual reconciliation.

---

## KI-003: Global CORS `origin: '*'` on all Fastify routes — any domain can call payment endpoints

**Problem:** Fastify is configured with `origin: '*'` globally in `processor/src/server/server.ts:42`. Every route — including `GET /payments`, `POST /confirmPayments/:id`, `GET /customer/session` — accepts cross-origin requests from any domain. The per-route `ALLOWED_ORIGINS` check applies only to `/express-config` via `corsAuthHook` — but that hook itself is a no-op whenever `ALLOWED_ORIGINS` is unset or empty (its own default), so the one endpoint meant to carry an origin restriction is fully open unless an operator explicitly sets the env var.
**Root cause:** `processor/src/server/server.ts:42` — CORS configured globally with no origin restriction. `processor/src/libs/fastify/cors/cors.ts:12-15` + `processor/src/config/config.ts:93` — `corsAuthHook` returns immediately when `ALLOWED_ORIGINS` is empty.
**Rule:** CORS must restrict origins to the known storefront domains. `origin: '*'` is appropriate only for fully public unauthenticated endpoints. `ALLOWED_ORIGINS` should be required (fail startup if absent), not silently permissive. See hub `known-issues.md` Issue 8.
**Implementation note:** `GET /applePayConfig` is intentionally public (Apple Pay domain verification). Other endpoints have session-header auth that mitigates the impact but does not eliminate CORS exposure. `POST /express-config` has neither session auth nor a working origin check by default.

---

## KI-004: `handleRequest()` in `actions.ts` does not await async post-deploy functions

**Problem:** `handleRequest()` at `processor/src/connectors/actions.ts:32` takes `fn: () => void` and does not `await` it, so an async post-deploy function it wraps (e.g. `createOrUpdateCustomerCustomType()`) can reject *after* `handleRequest` already returned — the failure is lost and the deploy succeeds regardless. (Note: `createLaunchpadPurchaseOrderNumberCustomType()`, `actions.ts:41-46`, does **not** go through `handleRequest` — it calls `getTypeByKey` directly — so it is not affected by this specific defect.)
**Root cause:** `processor/src/connectors/actions.ts:32` — `fn()` invoked without `await`; a rejected promise is never surfaced to the CT Connect SDK.
**Rule:** All async post-deploy lifecycle functions must be awaited with their errors propagated to the CT Connect SDK to fail the deploy.
**Implementation note:** If a custom type creation fails silently, the connector starts without the required custom type and runtime calls that depend on it produce confusing errors.

---

## KI-005: `retrieveWebhookEndpoint()` and `updateWebhookEndpoint()` errors swallowed in post-deploy

**Problem:** Both functions in `processor/src/connectors/actions.ts:54` (`retrieveWebhookEndpoint()`) and `:77` (`updateWebhookEndpoint()`) catch errors and only log them. If the Stripe webhook endpoint update fails during post-deploy, the deploy succeeds but the connector is registered at the old webhook URL. All incoming Stripe events are delivered to the stale endpoint, which may belong to a different environment.
**Root cause:** `processor/src/connectors/actions.ts:54–65` — try/catch absorbs Stripe errors without re-throwing.
**Rule:** Post-deploy failures that affect event delivery must abort the deploy. See hub `known-issues.md` Issue 4.
**Implementation note:** See hub `failure-modes.md — Stripe API: Webhook endpoint update fails at post-deploy`.

---

## KI-006: Enabler throws non-`Error` values on several processor-call failure paths

**Problem:** At `enabler/src/dropin/dropin-embedded.ts:201`, when `POST /confirmPayments/:id` fails, the code executes `throw "Error on /confirmPayments";` — a plain hardcoded string literal. The same pattern repeats on the Express Checkout path: `dropin-embedded.ts:136-138` and `express/dropin-express.ts:476-477` both `throw error` using the raw parsed JSON error body instead of wrapping it in an `Error`. Throwing a non-Error object causes catch handlers to receive a string or plain object, which breaks `error.message`, `error.stack`, and any instanceof checks in the host application.
**Root cause:** `enabler/src/dropin/dropin-embedded.ts:136-138,201`; `enabler/src/express/dropin-express.ts:476-477` — throw sites use string literals or raw JSON bodies, not wrapped `Error` instances.
**Rule:** All throw sites must throw an `Error` instance or a subclass. Throwing strings or plain objects breaks error propagation in TypeScript and host applications.
**Implementation note:** Host apps that catch this error and read `.message` or `.stack` will get `undefined`, on both the embedded drop-in and Express Checkout confirm paths.

---

## KI-007: Idempotency keys are `crypto.randomUUID()` on PI create/update; absent on capture/cancel

**Problem:** `paymentIntents.create()` and `paymentIntents.update()` use `crypto.randomUUID()` as idempotency key — a different value is generated each call, so a retry is treated as a new request and creates a duplicate PaymentIntent. `paymentIntents.capture()` and `paymentIntents.cancel()` carry no idempotency key at all — retries after network timeouts may double-capture or double-cancel.
**Root cause:** `processor/src/services/stripe-payment.service.ts` — no stable idempotency keys derived from CT payment ID at four call sites, named by their enclosing method rather than by line: `createPaymentIntentStripe()` (the `paymentIntents.create` call), `updatePaymentIntentMetadata()` (the `paymentIntents.update` call), `capturePayment()` and `cancelPayment()`. Line numbers are deliberately omitted — they were "corrected" on 2026-07-28 and all five had rotted again by 2026-08-13, so citing methods is the only reference that survives a refactor.
**Rule:** Every Stripe write must carry a key derived from a stable CT identifier (CT payment ID + operation type suffix). See hub `known-issues.md` Issue 5.
**Implementation note:** Workaround: disable HTTP retries at the infrastructure level on outbound Stripe calls.
**Narrowed 2026-08-13.** `refunds.create()` was removed from this issue: it carries a stable entity-derived key, `refund-{ctPaymentId}-{amount}`. See `business-rules/refunds-reversals.md` Rule 5 — "has a key" is not the same claim as "is idempotent", and that section states precisely what the refund key does and does not guarantee. `create` and `update` remain listed above and are correct as written: they still use `crypto.randomUUID()`.

---

## KI-008: `getCtCustomer()` swallows all CT lookup errors with `.catch(() => undefined)`

**Problem:** At `processor/src/services/stripe-payment.service.ts:1317` (`getCtCustomer()`), the CT customer lookup is called with a `.catch((err) => { log.warn(...); return; })` at line 1324. Any CT API error — including 500, network failure, or auth failure — is silently treated as "customer not found" and the connector continues as if the customer does not exist. A new Stripe customer may be created unnecessarily.
**Root cause:** `processor/src/services/stripe-payment.service.ts:1324` — blanket catch swallows all errors.
**Rule:** Only `404 Not Found` should be treated as "customer not found". All other errors must propagate.
**Implementation note:** Creates duplicate Stripe customers during CT API instability.

---

## KI-009: `fetchConfigData()` has no `response.ok` check — non-2xx config responses parsed as success

**Problem:** At `enabler/src/payment-enabler/payment-enabler-mock.ts:357` (`fetchConfigData()`), the function calls `fetch()` and immediately calls `.json()` on the response at line 367 without checking `response.ok`. A 400 or 500 error response with a JSON body is parsed as a configuration object. The connector initializes with garbage config silently.
**Root cause:** `enabler/src/payment-enabler/payment-enabler-mock.ts:367` — missing `if (!response.ok) throw new Error(...)` guard.
**Rule:** Every `fetch()` call must check `response.ok` before parsing the body.

---

## KI-010: `getCustomerOptions()` has no `response.ok` check — non-204 error responses are parsed as a valid customer session

**Problem:** At `enabler/src/payment-enabler/payment-enabler-mock.ts:433-444` (`getCustomerOptions()`), only a `204` is treated as guest checkout (returns `undefined`). **Any other status — including 400/500 errors from the processor — is not distinguished:** the code calls `await response.json()` on the error body and returns it as if it were a valid `CustomerResponseSchemaDTO`. A server error during customer session setup therefore feeds a bogus/error payload into the session flow rather than failing or degrading cleanly (same class of defect as KI-009: garbage config, not safe degradation). *(Corrected 2026-09-02 @ `10f0ab5`: this entry previously claimed non-204 responses returned null / degraded to guest checkout — the opposite of what the code does.)*
**Root cause:** `enabler/src/payment-enabler/payment-enabler-mock.ts:433-444` — the only status branch is `=== 204`; there is no `response.ok` check before `response.json()`, so error responses are parsed and returned as data.
**Rule:** Error status codes must be distinguished from both an intentional 204 No Content and a valid session body — add a `response.ok` check before parsing. See hub `business-rules/customer-data.md`.

---

## KI-011: `paymentIntents.update()` metadata patch is a separate Stripe call — failure orphans the CT Payment

**Problem:** `GET /payments` creates the PI, creates the CT Payment, adds the payment to the cart, then calls `paymentIntents.update()` to write `ct_payment_id` to PI metadata as a separate call. If this update fails, the CT Payment exists but the PI has no `ct_payment_id`. Webhook events for that PI cannot be matched to a CT Payment and are silently dropped.
**Root cause:** `processor/src/services/stripe-payment.service.ts:623` (`paymentIntents.update()` call) — metadata patch is not atomic with PI creation; no rollback on failure.
**Rule:** PI metadata must be written atomically at PI creation or via a reliable background retry. No CT Payment state should depend on a metadata field that can be lost. See hub `failure-modes.md — CT Platform API: CT unavailable`.
**Implementation note:** Orphaned PIs expire automatically (uncaptured manual PIs in 7 days; automatic PIs generate no charge). No automatic cleanup mechanism.

---

## KI-012: `STRIPE_WEBHOOK_SIGNING_SECRET` defaults to `''` — all webhooks silently rejected if not set

**Problem:** `processor/src/config/config.ts:72` defaults `STRIPE_WEBHOOK_SIGNING_SECRET` to `''`. If the env var is absent, `stripe.webhooks.constructEvent()` is called with an empty secret and throws `SignatureVerificationException` for every incoming webhook. The handler returns HTTP 400; Stripe retries for 72 hours then gives up. All webhook-driven CT updates fail permanently.
**Root cause:** `processor/src/config/config.ts:72` — empty string default with no startup validation.
**Rule:** `STRIPE_WEBHOOK_SIGNING_SECRET` must be validated as non-empty at startup. See hub `known-issues.md` Issue 2.

---

## KI-013: `STRIPE_SECRET_KEY`, `CTP_CLIENT_ID`, `CTP_CLIENT_SECRET` default to invalid placeholder strings — accepted at startup

**Problem:** `processor/src/config/config.ts:71` defaults `STRIPE_SECRET_KEY` to the literal `'stripeSecretKey'`; `:53-54` default `CTP_CLIENT_ID`/`CTP_CLIENT_SECRET` to `'xxx'`. If any of these env vars is not set, the server starts normally and makes Stripe or CT API calls with an invalid credential, producing authentication errors at runtime rather than a startup failure.
**Root cause:** `processor/src/config/config.ts:52-54,71` — placeholder defaults with no startup validation.
**Rule:** Required credentials must be validated at startup. A server that starts with placeholder credentials is worse than one that fails fast. See hub `known-issues.md` Issue 3.

---

## KI-014: `charge.succeeded` converter records `amount_refunded=0` as `centAmount` on the AUTHORIZATION transaction

**Problem:** At `processor/src/services/converters/stripeEventConverter.ts:117`, the converter for `charge.succeeded` reads `charge.amount_refunded` (which is `0` at creation) and writes it as the `centAmount` on the `AUTHORIZATION:SUCCESS` transaction. This creates an AUTHORIZATION transaction with `centAmount = 0`, which is misleading — the authorization amount should be `charge.amount`. The same shared `populateAmount()` helper (lines 110-124) is also reused for `charge.updated`, whose `CHARGE` transaction therefore also gets `amount_refunded` (likely `0`) instead of `amount_captured` — not independently confirmed against a live event payload. `charge.refunded` is unaffected: `amount_refunded` is the semantically correct field for that event.
**Root cause:** `processor/src/services/converters/stripeEventConverter.ts:117` — wrong field used for the authorization amount.
**Rule:** `AUTHORIZATION` transaction `centAmount` must be set from `charge.amount`, not `charge.amount_refunded`.

---

## KI-015: webhook-driven `populateAmountCanceled()` records full PI amount as `CANCEL_AUTHORIZATION` centAmount

**Problem:** At `processor/src/services/converters/stripeEventConverter.ts:129`, the `CANCEL_AUTHORIZATION` transaction records the full `payment_intent.amount` rather than the actual canceled amount. For partial captures with a residual amount, the cancel record is inaccurate. This runs on the **webhook path**: Stripe delivers a `payment_intent.canceled` event, `processStripeEvent()` calls `stripeEventConverter.convert()`, which dispatches to `populateAmountCanceled()`. It is not caused by the synchronous `cancelPayment()` service method — that method only calls `stripeApi().paymentIntents.cancel()` and returns; it writes no CT transaction amount itself.
**Root cause:** `processor/src/services/converters/stripeEventConverter.ts:129` — uses PI total amount, not the residual uncaptured amount.
**Rule:** `CANCEL_AUTHORIZATION` centAmount must reflect the actual amount being canceled, not the original PI amount.

---

## KI-016: `createLaunchpadPurchaseOrderNumberCustomType()` silently does nothing when the custom type doesn't exist

**Problem:** If the custom type doesn't already exist, `createLaunchpadPurchaseOrderNumberCustomType()` silently does nothing — it never creates the type. No empty body is sent; the create call is simply missing.
**Root cause:** `processor/src/connectors/actions.ts:41-46` — the function only calls `getTypeByKey()` (a read) and logs a message if the type is found; there is no create/update call to CT at all when the type is absent.
**Rule:** Post-deploy must either create the custom type with its required fields or fail loudly if the type is absent. Silent no-op is not acceptable.
**Implementation note:** The `payment-launchpad-purchase-order` custom type must be created manually before deploying. See `business-rules/` for required field definitions.

---

## KI-017: `payment_intent.requires_action` is method-dependent — a bank transfer writes a Pending authorization, card 3DS writes nothing

> **Rewritten 2026-08-13 (SB3-207).** This entry previously read "`requires_action` is a deliberate no-op (no CT transaction)". That statement is now false for one payment method and still true for the rest, which is precisely why it needs an entry rather than a deletion.

**Problem:** one Stripe event type, two behaviours. `payment_intent.requires_action` is emitted by card 3DS (`next_action.use_stripe_sdk`), Boleto (`boleto_display_details`), redirect-based methods (`redirect_to_url`), **ACH microdeposits (`verify_with_microdeposits`)** **and** bank transfers (`display_bank_transfer_instructions`). Only the last writes a CT transaction — an `Authorization/Pending` for `pi.amount`. All others keep a log-only path on that axis (ACH microdeposits therefore leaves the Payment at `Authorization/Initial` — confirmed 2026-08-27; its order axis is still driven, see `business-rules/order-payment-state.md` Rule 3).

> **Amended 2026-08-18 (SB3-207 task 028): "produce nothing" is no longer accurate, and the correction matters.** The sentence above used to end *"All others keep a log-only path and produce nothing."* Since ADR-009 there are **two** axes, and only the transaction axis is method-dependent:
>
> | | card 3DS / Boleto / redirect | bank transfer |
> | --- | --- | --- |
> | `Payment.transactions[]` | nothing (log-only) | `Authorization/Pending` |
> | `Order.paymentState` | **`Pending`** | **`Pending`** |
>
> So a 3DS `requires_action` *does* now write to commercetools — just to the order, not to the payment. The gate `isBankTransferNextAction()` governs the transaction axis only, and `reflectOrderPaymentStateBestEffort()` is called **above** it in the route on purpose. Anyone reading this entry as licence to widen the predicate so 3DS "gets its order state" would reintroduce the exact regression the predicate exists to prevent. See `business-rules/order-payment-state.md` Rule 3.

**Root cause / mechanism:** the discrimination is at the route, `processor/src/routes/stripe-payment.route.ts`, via `isBankTransferNextAction()` in `processor/src/utils.ts`. The converter's `case PAYMENT_INTENT__REQUIRED_ACTION` is unconditional and is only ever reached for bank transfers.

**Rule:** every registered webhook event must have a defined behaviour. This one's is "Pending authorization for bank transfer, log-only for every other `next_action` variant". Do not restate it as unconditional in either direction.

**Implementation note — the failure mode to understand before touching the predicate.** Widening it writes an `Authorization/Pending` on every 3DS card payment; narrowing it to nothing kills the bank transfer rail with a green suite. Both directions are held by release-gate tests, and the second only because a mirror assertion exists — a gate written purely in the negative cannot tell "correctly rejects 3DS" from "rejects everything".

**Still true from the original entry:** an async 3DS failure that surfaced only via webhook would not update CT. That remains an edge case, since 3DS resolves client-side in the current flow.

---

## KI-018: `global.d.ts` imports a type that doesn't exist — `SessionContextData` is never exported

**Problem:** `processor/src/global.d.ts:2` imports `SessionContextData` from `./libs/fastify/context/context`, but that module only exports `ContextData` and related functions — no `SessionContextData` is declared or exported anywhere in the codebase.
**Root cause:** `processor/src/global.d.ts:2`; `processor/src/libs/fastify/context/context.ts` (no matching export).
**Rule:** Every type import must resolve to a real export. A dangling type import is either dead code or a sign the type was renamed without updating this file.
**Implementation note:** Found via `--refresh` on 2026-07-27; TypeScript's ambient `.d.ts` handling may mask this at compile time depending on `skipLibCheck` — verify build output before treating as harmless.

---

## KI-019: `createComponentBuilder()` always throws — hardcoded empty `supportedMethods` map contradicts its own documented usage

**Problem:** `createComponentBuilder(type)` checks `Object.keys(supportedMethods).includes(type)`, but `supportedMethods` is hardcoded to `{}` — so the check always fails and the method always throws `"Component type not supported"`, for every `type` including `'card'`, which is the exact usage shown in the method's own JSDoc example.
**Root cause:** `enabler/src/payment-enabler/payment-enabler.ts:16-22`; `enabler/src/payment-enabler/payment-enabler-mock.ts:194-209` — `supportedMethods` never populated.
**Rule:** A publicly documented method must either work as documented or be removed/marked unsupported in its own docstring. Only `createDropinBuilder('embedded')` and `createExpressBuilder` are actually functional.
**Implementation note:** Any host application following the enabler's own example code for individual payment-method components will get a runtime exception on every call.

---

## KI-020: `getElements()` swallows Stripe Elements init errors and returns `null`; the only caller doesn't null-check before using it

**Problem:** `getElements()` wraps `stripeSDK.elements({...})` in try/catch, logs any error, and returns `null` on failure. Its only caller (`_Setup`) immediately calls `elements.create('payment', elementsOptions)` on the result with no null-check — converting a handled, logged failure into an unhandled `TypeError` one line later.
**Root cause:** `enabler/src/payment-enabler/payment-enabler-mock.ts:178,300-303` (checkout); same pattern in composable at `enabler/src/payment-enabler/payment-enabler-mock.ts:159-194,220-230`.
**Rule:** A function that catches and logs an error to "handle" it must not leave callers free to immediately dereference the null result — either rethrow, or null-check at every call site.
**Implementation note:** Present in both `ct-connect-stripe-checkout` and `ct-connect-stripe-composable` enablers — same root pattern, found independently in each during this refresh.

---

## KI-021: `@sinclair/typebox` used by enabler source but not declared in `enabler/package.json`

**Problem:** `enabler/src/dtos/mock-payment.dto.ts` imports `@sinclair/typebox`, and this import is transitively pulled into `payment-enabler-mock.ts`, `dropin-embedded.ts`, and `express/dropin-express.ts`. It resolves today only because it happens to already exist in `enabler/node_modules` (installed as a side effect of hoisting or a prior sibling install) — it is not listed in `enabler/package.json` dependencies, only in `processor/package.json`.
**Root cause:** `enabler/src/dtos/mock-payment.dto.ts:1`; missing entry in `enabler/package.json` dependencies.
**Rule:** Every module's declared dependencies must be sufficient for a clean install of that module alone.
**Implementation note:** A clean `npm install` of `enabler/` in isolation (e.g. in CI with no hoisted `processor/` install alongside it) would fail to resolve this import.

---

## KI-022: Express Checkout shipping-callback errors re-thrown inside an unawaited Stripe event callback → unhandled promise rejection

**Problem:** `handleShippingAddressChange` and `handleShippingRateChange` catch errors from CT shipping calls, call `reject()` and `onError()` to report the failure through the normal channel, then re-throw the same error. Since these run inside a Stripe `el.on(...)` event handler whose returned promise Stripe never awaits, the re-throw becomes an unhandled promise rejection in the browser — it reports nothing to the host application beyond what `reject()`/`onError()` already did, but does surface as a console error / unhandled rejection warning.
**Root cause:** `enabler/src/express/dropin-express.ts:307-311,335-339`.
**Rule:** Don't re-throw inside an event-handler callback whose promise isn't awaited by the caller — it adds console noise without adding information the host application can act on.

---

## KI-023: `handlePaymentConfirm` discards the real error and always reports a generic message

**Problem:** The catch block in `handlePaymentConfirm` (Express Checkout confirm flow) reports `'Error during payment confirmation.'` via `onError`/`onComplete` regardless of the actual cause — a Stripe decline reason, a network failure, and a processor 500 all surface identically to the host application.
**Root cause:** `enabler/src/express/dropin-express.ts:452-457`.
**Rule:** Error handlers exposed to the host application should preserve the real failure reason where the SDK provides one — a generic message prevents the merchant's frontend from showing decline-specific guidance to the shopper.

---

## KI-024: `EnablerOptions.sessionId` is typed as required but `createExpressBuilder` treats it as optional

**Problem:** `EnablerOptions.sessionId` is declared as a required `string` in the type definition, but `createExpressBuilder` branches on `this.options.sessionId ? ... : ...` — implying Express Checkout can legitimately run without a session (Express-without-session flow). The type declaration does not match the actual runtime contract.
**Root cause:** `enabler/src/payment-enabler/payment-enabler.ts:136`; `enabler/src/payment-enabler/payment-enabler-mock.ts:236-238`.
**Rule:** A field that is sometimes absent by design should be typed `sessionId?: string`, not `sessionId: string` — the current type actively misleads integrators into assuming it's always required.

---

## KI-025: `charge.refunded` webhook writes a `CHARGE_BACK` transaction on every ordinary refund, not only on real disputes

**Problem:** `stripeEventConverter.ts`'s `populateTransactions()` handles `StripeEvent.CHARGE__REFUNDED` by returning **two** transactions: `REFUND: SUCCESS` and `CHARGE_BACK: SUCCESS` (both using the same `populateAmount()` value). This runs for every merchant- or customer-initiated refund processed through this connector's own `refundPayment()` → `charge.refunded` webhook path — there is no distinction between an ordinary refund and an actual Stripe dispute/chargeback. No `charge.dispute.*` event is registered, so real disputes never reach this code path; the `CHARGE_BACK` transaction is written exclusively as a side effect of normal refunds. Found during the 2026-07-28 docs-audit: `ARCHITECTURE.md`'s "Transaction types used" table and `feature-scope.md`'s dispute note both previously (incorrectly) stated `CHARGE_BACK` is "manual only, no handler" — corrected as part of this audit.
**Root cause:** `processor/src/services/converters/stripeEventConverter.ts:68-83` (`case StripeEvent.CHARGE__REFUNDED`) — unconditionally emits a `CHARGE_BACK` transaction alongside `REFUND`.
**Rule:** `CHARGE_BACK` should only be written when Stripe reports an actual dispute (`charge.dispute.*`), never as a byproduct of a normal refund. Reusing a chargeback-specific CT transaction type for ordinary refunds corrupts any downstream dispute-rate or chargeback reporting built on CT transaction data.
**Implementation note:** Any merchant-facing dashboard or export that counts `CHARGE_BACK` transactions as "disputes" will overcount by the full volume of ordinary refunds processed by this connector. This is independent of KI-015 (which affects the *cancel* amount) and KI-014 (which affects the *authorization* amount) — same converter file, same `amount_refunded` reuse pattern, different transaction type.

---

## KI-026: async-settlement Pending write is a read-then-write (TOCTOU) between the sync gate and the webhook

**Problem:** For an async-settlement PaymentIntent (`processing` — crypto/stablecoin, ACH-style), the `AUTHORIZATION:PENDING` transaction can be written from two paths: the synchronous confirm gate (`updatePaymentIntentStripeSuccessful()`) and the `payment_intent.processing` webhook (`processStripeEvent()`). Both guard with `hasTransactionInState()` (read) before `updatePayment()` (write), but the check-then-write is not atomic. Under concurrency both can pass the check and attempt the write; one loses on CT optimistic locking (409 `ConcurrentModification`).
**Root cause:** `processor/src/services/stripe-payment.service.ts` — dedup read (`hasTransactionInState`) and the subsequent `updatePayment()` are separate calls in both the gate and the webhook handler; no lock or idempotency key spans them.
**Rule:** The safe end state relies on CT optimistic locking + the connector's retry + the dedup re-check on retry. No double charge or double order results, but a transient duplicate `Pending` or a spurious 400 to the shopper is possible. Observed live during E2E and recovered by retry.
**Implementation note:** Fully mitigated by deriving a stable idempotency key from the CT payment ID (see KI-007). For crypto the gate does not run (redirect → webhook-driven), so the race is webhook-vs-webhook and further reduced by keeping a single webhook forwarder in dev.

---

## KI-027: enabler signals a `pending` confirm outcome as `isSuccess: false` (reads like a decline)

**Problem:** In `enabler/src/dropin/dropin-embedded.ts` `confirmPaymentIntent()`, a `pending` outcome (HTTP 202, async settlement still processing) calls `onComplete({ isSuccess: false })`. This is the **safe** choice — it never signals premature success, so the merchant does not fulfill before settlement. But the `PaymentResult` contract (`enabler/src/payment-enabler/payment-enabler.ts`) treats `isSuccess: false` as a genuine failure, so the host may render a "failed/retry" screen for a payment that is settling normally.
**Root cause:** `enabler/src/dropin/dropin-embedded.ts` — no dedicated "processing" result state; `pending` reuses `isSuccess: false`.
**Rule:** Preventing premature fulfillment takes priority (satisfied). A dedicated processing/pending result state on `PaymentResult` is the proper fix.
**Implementation note:** Not on the crypto path — crypto is redirect-based and webhook-driven, so the synchronous gate/enabler branch is not hit (verified via E2E). Becomes a real UX requirement for non-redirect async methods (ACH, bank transfers), which DO confirm synchronously through the gate.

---

## KI-028: recurring `checkoutTransactionItemId` is caller-supplied and not bound to a cart transaction item

**Problem:** In `handleTransaction` (recurring `POST /operations/transactions`), `draft.checkoutTransactionItemId` is only UUID-format-validated, never verified to reference a real transaction item on the resolved cart. It is used as the CT `Payment.key` (the unique cross-window dedup anchor) and the native `checkoutTransactionItemId` linkage field. A caller with `manage_checkout_transactions` could pass a guessed/seeded uuid.
**Root cause:** `processor/src/services/stripe-payment.service.ts` — the anchor is validated for format (`UUID_RE`) only; there is no binding to a cart-side transaction item.
**Rule:** Bounded today by OAuth2/JWT auth + the customer-bound cart + the IDOR resolver (`resolveSavedPaymentMethodForCharge`) + the reuse-not-recreate design (a pre-seeded empty payment is just driven with the legitimate, IDOR-verified charge; an attacker cannot cheaply seed a *resolved* one). Residual severity: LOW. Proper fix: resolve `checkoutTransactionItemId` against a real transaction item on the cart before use.
**Implementation note:** Deferred follow-up — queued as a FEATURE in `workspace/2026-09-21-recurring-dedup-key/tasks-queue.json` (security MEDIUM-2 from the key-based dedup session). The ownership guard applied symmetrically across the short-circuit / reuse / duplicate-winner paths partially mitigates it. Introduced with the b3 `Payment.key` dedup (ADR-011).
