# Known Issues — ct-connect-stripe-checkout

Connector-specific limitations, code defects, and operational gotchas. Cross-cutting issues (webhook swallow, idempotency, CORS, credential defaults) are also documented in the hub `context/known-issues.md` — cross-references are noted below.

---

## KI-001: Webhook event handlers swallow all errors → HTTP 200 on CT update failure → permanent state divergence

**Problem:** `processStripeEvent()`, `processStripeEventRefunded()`, `processStripeEventMultipleCaptured()`, and `storePaymentMethod()` each contain a top-level try/catch that logs the exception and returns void. The route handler then returns HTTP 200 to Stripe, which considers the event delivered and never retries. The CT payment object is left in an inconsistent state with no automatic recovery.
**Root cause:** `processor/src/services/stripe-payment.service.ts:959, 1080, 1128, 1032` — all event processing functions absorb exceptions before they can bubble to the route layer.
**Rule:** Webhook handlers must return HTTP 5xx when CT update fails so Stripe retries. See hub `known-issues.md` Issue 1.
**Implementation note:** Affected events: `charge.succeeded`, `charge.updated`, `charge.refunded`, `payment_intent.succeeded`, `payment_intent.canceled`, `payment_intent.payment_failed`.

---

## KI-002: capturePayment/cancelPayment/refundPayment catch Stripe errors and return REJECTED with no CT state update

**Problem:** `capturePayment()`, `cancelPayment()`, and `refundPayment()` each have a try/catch that catches Stripe API errors and returns `{ outcome: 'REJECTED' }` with HTTP 200. When Stripe rejects the operation, no CT Payment transaction is written and the CT payment state is not updated to reflect the failure.
**Root cause:** `processor/src/services/stripe-payment.service.ts:232, 265, 318` — error is caught, logged, and converted to REJECTED outcome without updating CT.
**Rule:** After a Stripe operation failure, the CT payment must be updated to a FAILED state before returning. See hub `failure-modes.md — Stripe API: Payment Intent operations`.
**Implementation note:** The operator dashboard shows REJECTED with no Stripe error details. CT/Stripe divergence requires manual reconciliation.

---

## KI-003: Global CORS `origin: '*'` on all Fastify routes — any domain can call payment endpoints

**Problem:** Fastify is configured with `origin: '*'` globally in `processor/src/server/server.ts:43`. Every route — including `GET /payments`, `POST /confirmPayments/:id`, `GET /customer/session` — accepts cross-origin requests from any domain. The per-route `ALLOWED_ORIGINS` check applies only to `/express-config` via `corsAuthHook`.
**Root cause:** `processor/src/server/server.ts:43` — CORS configured globally with no origin restriction.
**Rule:** CORS must restrict origins to the known storefront domains. `origin: '*'` is appropriate only for fully public unauthenticated endpoints. See hub `known-issues.md` Issue 15.
**Implementation note:** `GET /applePayConfig` is intentionally public (Apple Pay domain verification). Other endpoints have session-header auth that mitigates the impact but does not eliminate CORS exposure.

---

## KI-004: `handleRequest()` in `actions.ts` does not await async post-deploy functions

**Problem:** `handleRequest()` at `processor/src/connectors/actions.ts:32` is async but the functions it invokes (`createOrUpdateCustomerCustomType()`, `createLaunchpadPurchaseOrderNumberCustomType()`, etc.) are awaited only partially — the top-level caller of `handleRequest` does not await its result. Post-deploy functions may fail silently and the deploy succeeds regardless.
**Root cause:** `processor/src/connectors/actions.ts:32` — missing await on async function call.
**Rule:** All async post-deploy lifecycle functions must be awaited with their errors propagated to the CT Connect SDK to fail the deploy.
**Implementation note:** If a custom type creation fails silently, the connector starts without the required custom type and runtime calls that depend on it produce confusing errors.

---

## KI-005: `retrieveWebhookEndpoint()` and `updateWebhookEndpoint()` errors swallowed in post-deploy

**Problem:** Both functions in `processor/src/connectors/actions.ts:54, 65` catch errors and only log them. If the Stripe webhook endpoint update fails during post-deploy, the deploy succeeds but the connector is registered at the old webhook URL. All incoming Stripe events are delivered to the stale endpoint, which may belong to a different environment.
**Root cause:** `processor/src/connectors/actions.ts:54–65` — try/catch absorbs Stripe errors without re-throwing.
**Rule:** Post-deploy failures that affect event delivery must abort the deploy. See hub `known-issues.md` Issue 6.
**Implementation note:** See hub `failure-modes.md — Stripe API: Webhook endpoint update fails at post-deploy`.

---

## KI-006: Enabler throws a string literal on `/confirmPayments` failure instead of an `Error` object

**Problem:** At `enabler/src/dropin/dropin-embedded.ts:189`, when `POST /confirmPayments/:id` fails, the code executes `throw response.errors[0]` or a similar string literal. Throwing a non-Error object causes catch handlers to receive a string, which breaks `error.message`, `error.stack`, and any instanceof checks in the host application.
**Root cause:** `enabler/src/dropin/dropin-embedded.ts:189` — throws a raw string or plain object, not a wrapped `Error`.
**Rule:** All throw sites must throw an `Error` instance or a subclass. Throwing strings breaks error propagation in TypeScript and host applications.
**Implementation note:** Host apps that catch this error and read `.message` or `.stack` will get `undefined`.

---

## KI-007: Idempotency keys are `crypto.randomUUID()` on PI create; absent on capture/cancel/refund

**Problem:** `paymentIntents.create()` uses `crypto.randomUUID()` as idempotency key — a different value is generated each call, so retries create duplicate PIs. `paymentIntents.capture()`, `paymentIntents.cancel()`, and `refunds.create()` carry no idempotency key — retries after network timeouts may double-capture, double-cancel, or double-refund.
**Root cause:** `processor/src/services/stripe-payment.service.ts:498` (create), `580` (update), `211` (capture), `250` (cancel), `303` (refund) — no stable idempotency keys derived from CT payment ID.
**Rule:** Every Stripe write must carry a key derived from a stable CT identifier (CT payment ID + operation type suffix). See hub `known-issues.md` Issue 7.
**Implementation note:** Workaround: disable HTTP retries at the infrastructure level on outbound Stripe calls.

---

## KI-008: `getCtCustomer()` swallows all CT lookup errors with `.catch(() => undefined)`

**Problem:** At `processor/src/services/stripe-payment.service.ts:1255`, `getCtCustomer()` is called with `.catch(() => undefined)`. Any CT API error — including 500, network failure, or auth failure — is silently treated as "customer not found" and the connector continues as if the customer does not exist. A new Stripe customer may be created unnecessarily.
**Root cause:** `processor/src/services/stripe-payment.service.ts:1255` — blanket catch swallows all errors.
**Rule:** Only `404 Not Found` should be treated as "customer not found". All other errors must propagate.
**Implementation note:** Creates duplicate Stripe customers during CT API instability.

---

## KI-009: `fetchConfigData()` has no `response.ok` check — non-2xx config responses parsed as success

**Problem:** At `enabler/src/payment-enabler/payment-enabler-mock.ts:289`, `fetchConfigData()` calls `fetch()` and immediately calls `.json()` on the response without checking `response.ok`. A 400 or 500 error response with a JSON body is parsed as a configuration object. The connector initializes with garbage config silently.
**Root cause:** `enabler/src/payment-enabler/payment-enabler-mock.ts:289` — missing `if (!response.ok) throw new Error(...)` guard.
**Rule:** Every `fetch()` call must check `response.ok` before parsing the body.

---

## KI-010: `getCustomerOptions()` has no `response.ok` check — non-204 error responses treated as guest checkout

**Problem:** At `enabler/src/payment-enabler/payment-enabler-mock.ts:330`, `getCustomerOptions()` treats any non-204 response (including 400 and 500 errors from the processor) as "guest checkout" and returns null. A server error during customer session setup silently degrades to guest mode without notifying the host application.
**Root cause:** `enabler/src/payment-enabler/payment-enabler-mock.ts:330` — status code check is `=== 204` only; any other status (including error codes) falls through to the null return.
**Rule:** Error status codes must be distinguished from intentional 204 No Content. See hub `business-rules/customer-data.md`.

---

## KI-011: `paymentIntents.update()` metadata patch is a separate Stripe call — failure orphans the CT Payment

**Problem:** `GET /payments` creates the PI, creates the CT Payment, adds the payment to the cart, then calls `paymentIntents.update()` to write `ct_payment_id` to PI metadata as a separate call. If this update fails, the CT Payment exists but the PI has no `ct_payment_id`. Webhook events for that PI cannot be matched to a CT Payment and are silently dropped.
**Root cause:** `processor/src/services/stripe-payment.service.ts:581` — metadata patch is not atomic with PI creation; no rollback on failure.
**Rule:** PI metadata must be written atomically at PI creation or via a reliable background retry. No CT Payment state should depend on a metadata field that can be lost. See hub `failure-modes.md — CT Platform API: CT unavailable`.
**Implementation note:** Orphaned PIs expire automatically (uncaptured manual PIs in 7 days; automatic PIs generate no charge). No automatic cleanup mechanism.

---

## KI-012: `STRIPE_WEBHOOK_SIGNING_SECRET` defaults to `''` — all webhooks silently rejected if not set

**Problem:** `processor/src/config/config.ts:36` defaults `STRIPE_WEBHOOK_SIGNING_SECRET` to `''`. If the env var is absent, `stripe.webhooks.constructEvent()` is called with an empty secret and throws `SignatureVerificationException` for every incoming webhook. The handler returns HTTP 400; Stripe retries for 72 hours then gives up. All webhook-driven CT updates fail permanently.
**Root cause:** `processor/src/config/config.ts:36` — empty string default with no startup validation.
**Rule:** `STRIPE_WEBHOOK_SIGNING_SECRET` must be validated as non-empty at startup. See hub `known-issues.md` Issue 4.

---

## KI-013: `STRIPE_SECRET_KEY` defaults to `'stripeSecretKey'` — invalid credentials accepted at startup

**Problem:** `processor/src/config/config.ts:35` defaults `STRIPE_SECRET_KEY` to the literal `'stripeSecretKey'`. If the env var is not set, the server starts normally and makes Stripe API calls with an invalid key, producing authentication errors at runtime rather than a startup failure.
**Root cause:** `processor/src/config/config.ts:35` — placeholder default with no startup validation.
**Rule:** Required credentials must be validated at startup. A server that starts with placeholder credentials is worse than one that fails fast. See hub `known-issues.md` Issue 5.

---

## KI-014: `charge.succeeded` converter records `amount_refunded=0` as `centAmount` on the AUTHORIZATION transaction

**Problem:** At `processor/src/services/converters/stripeEventConverter.ts:116`, the converter for `charge.succeeded` reads `charge.amount_refunded` (which is `0` at creation) and writes it as the `centAmount` on the `AUTHORIZATION:SUCCESS` transaction. This creates an AUTHORIZATION transaction with `centAmount = 0`, which is misleading — the authorization amount should be `charge.amount`.
**Root cause:** `processor/src/services/converters/stripeEventConverter.ts:116` — wrong field used for the authorization amount.
**Rule:** `AUTHORIZATION` transaction `centAmount` must be set from `charge.amount`, not `charge.amount_refunded`.

---

## KI-015: `cancelPayment()` converter records full PI amount as `CANCEL_AUTHORIZATION` centAmount

**Problem:** At `processor/src/services/converters/stripeEventConverter.ts:129`, the `CANCEL_AUTHORIZATION` transaction created by `cancelPayment()` records the full `payment_intent.amount` rather than the actual canceled amount. For partial captures with a residual amount, the cancel record is inaccurate.
**Root cause:** `processor/src/services/converters/stripeEventConverter.ts:129` — uses PI total amount, not the residual uncaptured amount.
**Rule:** `CANCEL_AUTHORIZATION` centAmount must reflect the actual amount being canceled, not the original PI amount.

---

## KI-016: `createLaunchpadPurchaseOrderNumberCustomType()` sends an empty body to CT

**Problem:** At `processor/src/connectors/actions.ts:41`, `createLaunchpadPurchaseOrderNumberCustomType()` is called but the request body sent to CT is missing the field definitions. The function checks for existence of the custom type but does not create or update it — the body sent to the CT API is empty `{}`.
**Root cause:** `processor/src/connectors/actions.ts:41` — the custom type create call omits the fields array.
**Rule:** Post-deploy must either create the custom type with its required fields or fail loudly if the type is absent. Silent no-op is not acceptable.
**Implementation note:** The `payment-launchpad-purchase-order` custom type must be created manually before deploying. See `business-rules/` for required field definitions.

---

## KI-017: `payment_intent.requires_action` is registered in the webhook endpoint but has no handler — events silently dropped

**Problem:** `payment_intent.requires_action` is listed in the `enabledEvents` array in `processor/src/connectors/actions.ts` and is delivered by Stripe. Inside `processStripeEvent()`, the converter has no case for this event type and throws `Unsupported event ...`, which is caught by the error-swallowing try/catch (KI-001). No CT update is made.
**Root cause:** `processor/src/connectors/actions.ts` (event registration) + `processor/src/services/converters/stripeEventConverter.ts` (no case for `payment_intent.requires_action`).
**Rule:** Every registered webhook event must have a handler. Remove from `enabledEvents` if not handled, or implement the handler.
**Implementation note:** 3DS is handled client-side by Stripe.js before the webhook arrives. The webhook event is not strictly necessary for the current flow but its silent drop masks any edge case where 3DS fails asynchronously.
