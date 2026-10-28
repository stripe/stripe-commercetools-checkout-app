# Workflow: Standard Embedded Payment

**Trigger:** Customer reaches checkout; the host constructs `new Enabler({ processorUrl, sessionId })`, calls `createDropinBuilder('embedded')` and mounts the Stripe Payment Element.
**Modules involved:** enabler, processor.
**Actors:** Browser (Enabler), Processor, Stripe API, CT API.
**Outcome:** CT Payment with `Authorization/Success` (HTTP 200 `approved`), or `Authorization/Pending` (HTTP 202 `pending`) for an async-settlement rail; Stripe PI in `succeeded` / `requires_capture` (or `processing` / bank transfer `requires_action`); the host's `onComplete` called.

> `GET /payments` (steps 7–14) is shared with Express Checkout — see `process-express-checkout.md` for what differs there.

## Happy Path

### 1. Initialization

1. `createDropinBuilder` accepts only `embedded`; `_Setup` runs once per `Enabler` instance and its promise is cached — `enabler/src/payment-enabler/payment-enabler-mock.ts:211-231`, `:108-113`
2. Enabler fetches config in parallel with `X-Session-Id`: `GET /config-element/payment` (appearance, layout, capture method, billing-address setting, flow type, `setupFutureUsage`, cart amount) and `GET /operations/config` (publishable key, environment) — `enabler/src/payment-enabler/payment-enabler-mock.ts:357-368`
3. Processor `initializeCartPayment`: resolves the cart's behavior rule through the **same** trusted resolver as PI creation (`cart.country` / `cart.store.key` only), then capture method, billing-address collection, flow type, cart amount; drops `setupFutureUsage` under `pi_first` — `processor/src/services/stripe-payment.service.ts:1861-1925` (resolver `:1880`; `pi_first` `:1890-1893`). `GET /operations/config` returns `config()` — `processor/src/routes/operation.route.ts:35-49`; `processor/src/services/stripe-payment.service.ts:213-222`
4. Enabler loads Stripe.js with the publishable key — `enabler/src/payment-enabler/payment-enabler-mock.ts:143,254-263`
5. Enabler calls `GET /customer/session` **always**; the processor answers 204 for a cart without `customerId`, otherwise `{stripeCustomerId, ephemeralKey, sessionId}` (enables saved payment methods; see `stripe-customer-session.md`) — `enabler/src/payment-enabler/payment-enabler-mock.ts:144,433-444`
6. `pi_first` only: `GET /payments` is called now and its client secret initialises Elements; the full response is cached in `baseOptions.piFirstResponse` and `submit()` never calls `GET /payments` again — `enabler/src/payment-enabler/payment-enabler-mock.ts:155-158,370-385`
7. `stripe.elements(...)` — deferred mode with `amount`, `currency`, `capture_method` and, when a customer was returned, `customerOptions` + `setupFutureUsage` + `customerSessionClientSecret`; or `{ clientSecret }` under `pi_first` — then `elements.create('payment', ...)` — `enabler/src/payment-enabler/payment-enabler-mock.ts:160-166,265-304,178`. The drop-in mounts it — `enabler/src/dropin/dropin-embedded.ts:76-82`

### 2. Payment Intent creation (`GET /payments`)

8. User clicks Pay; `submit()` runs `elements.submit()` (validates the form) — `enabler/src/dropin/dropin-embedded.ts:84-90`
9. Deferred flow: `GET /payments` with `x-session-id` (no express headers) — `enabler/src/dropin/dropin-embedded.ts:106-110,129-143`; route reads `x-express-checkout` / `x-express-customer-session` (both absent here) — `processor/src/routes/stripe-payment.route.ts:84-90`
10. Processor reads the cart from CT for amount and currency, resolves the trusted behavior rule and the steering comparison, loads the CT customer, shipping address, payment amount; computes capture method, merchant return URL (request context, else `MERCHANT_RETURN_URL`), `setup_future_usage` and flow type; warns if bank transfer will be suppressed for this cart — `processor/src/services/stripe-payment.service.ts:754-810`
11. **Reuse check.** Before creating anything, each payment on the cart is examined: this connector's `paymentInterface`, same amount and currency, an `Authorization/Initial` with a PI id, PI still open (`requires_payment_method` / `requires_confirmation` / `requires_action`) and its configuration (capture method, applied `setup_future_usage`, customer binding, shipping presence) matching what this request would create. A match is reused (its `ct_payment_id` stamp is re-applied if missing) and returned without a new PI or Payment — `processor/src/services/stripe-payment.service.ts:819-844,1048-1079,1203-1352`
12. Tax hook: the cart's Stripe Tax calculation reference is attached only when there is exactly one — `processor/src/services/stripe-payment.service.ts:846-848,1026-1041`
13. `paymentIntents.create` (per-call random idempotency key) with amount, currency, capture method, `automatic_payment_methods`, metadata `cart_id` / `ct_project_key` / `ct_customer_id`, customer and `setup_future_usage` (only when a Stripe customer is bound), shipping, multicapture request (multi-ops only), `customer_balance` options (EUR + configured IBAN country), tax hook — `processor/src/services/stripe-payment.service.ts:850-880,1423-1533`
14. `createPayment` with key `pi-create-{cartId}-{cartVersion}`, `paymentInterface`, customer or anonymous id, and an **`Authorization/Initial`** transaction whose `interactionId` is the PI id — `processor/src/services/stripe-payment.service.ts:897-920`
15. `addPayment` associates the CT Payment to the cart — `processor/src/services/stripe-payment.service.ts:936-942`
16. **Then** a second Stripe call writes `ct_payment_id = ctPayment.id` into the PI metadata. It happens after `createPayment` because the id does not exist before. Full order: `paymentIntents.create` (`:875`) → `createPayment` (`:900`) → `addPayment` (`:936`) → `updatePaymentIntentMetadata` (`:951`, body `:1390-1405`) — `processor/src/services/stripe-payment.service.ts`
17. Returns `sClientSecret`, `paymentReference`, `merchantReturnUrl`, `cartId` and, unless billing collection is `auto`, `billingAddress` — `processor/src/services/stripe-payment.service.ts:955-961,1407-1413`

### 3. Stripe confirmation (`stripe.confirmPayment()`)

18. Enabler calls Stripe.js `confirmPayment({ elements, clientSecret, confirmParams: { return_url (+cartId, paymentReference), billing_details? }, redirect: 'if_required' })`. Stripe handles 3DS, redirect-based methods and card validation. On success the PI moves to `succeeded` (automatic capture) or `requires_capture` (manual) — `enabler/src/dropin/dropin-embedded.ts:112-118,145-168`
19. A bank transfer awaiting funds is **not** an error: if Stripe.js reports the dismissed instructions modal as an error, the PI is re-read and, if it is `requires_action` with bank-transfer instructions, the flow continues — `enabler/src/dropin/dropin-embedded.ts:170-189,228-240`. Every other `requires_action` and any `last_payment_error` throws — `enabler/src/dropin/dropin-embedded.ts:205-216`

### 4. Backend confirmation (`POST /confirmPayments/:id`)

20. Enabler sends `{ paymentIntent }` to `POST /confirmPayments/{paymentReference}` — `enabler/src/dropin/dropin-embedded.ts:120-123,242-251`
21. Processor loads the session cart and the CT Payment, then validates before any write (`business-rules/payment-lifecycle.md` Rule 2 "The confirm gate validates the PaymentIntent before CT is updated — six checks") — `processor/src/services/stripe-payment.service.ts:1547-1630`:
    1. the session cart references `paymentReference` (cross-cart binding) — `:1572,1686-1695`
    2. the PI is retrieved from Stripe — `:1575-1585`
    3. status is `succeeded`, `requires_capture`, `processing`, or `requires_action` **with** bank-transfer instructions — `:1596-1608`
    4. `metadata.ct_payment_id === paymentReference` — `:1718-1726`
    5. `metadata.cart_id ===` session cart id (origin cart) — `:1728-1737`
    6. PI amount and currency equal `amountPlanned` — `:1614-1630`
22. Async settlement (`processing`, or bank transfer awaiting funds): writes `Authorization/Pending` (deduped against an existing Pending or `Charge/Success`) and returns `pending` — `processor/src/services/stripe-payment.service.ts:1653-1656,1755-1780`. See `process-async-settlement.md`
23. Otherwise updates the CT Payment with **an `AUTHORIZATION` transaction in `Success`** — always AUTHORIZATION, regardless of capture method; no branch writes CHARGE here. The `Charge/Success` comes later from the `payment_intent.succeeded` webhook (step 26) — `processor/src/services/stripe-payment.service.ts:1658-1669`
24. Route maps `pending` → 202, anything else → 200 — `processor/src/routes/stripe-payment.route.ts:116-123`
25. Drop-in: outcome `pending` → `onComplete({ isSuccess: false })`; otherwise `onComplete({ isSuccess: true, paymentReference })` — `enabler/src/dropin/dropin-embedded.ts:257-268`

### 5. Async webhook (parallel path)

26. Stripe sends `payment_intent.succeeded` / `charge.succeeded`; the processor records `Charge/Success` or `Authorization/Success` in CT, stores the payment method if the customer opted in, and creates a recurring job if applicable. The webhook path records the payment independently of steps 20–25 — see `process-webhook.md` — `processor/src/routes/stripe-payment.route.ts:258-272`

## Error Paths

| Condition | Behavior | File |
| --- | --- | --- |
| Any setup failure | the rejected `_Setup` promise is cached; a new `Enabler` is needed | `enabler/src/payment-enabler/payment-enabler-mock.ts:108-113` |
| Builder type other than `embedded` | throws | `enabler/src/payment-enabler/payment-enabler-mock.ts:223-229` |
| Elements validation fails (invalid card data) | `submit()` throws to `onError`; no PI created; CT unchanged | `enabler/src/dropin/dropin-embedded.ts:86-90,124-126` |
| `/payments` fails at Stripe create (CT or Stripe API failure before the PI exists) | wrapped and re-thrown; no PI created; CT unchanged | `processor/src/services/stripe-payment.service.ts:878-880` |
| A PI on the cart is already `succeeded` / `requires_capture` / `processing` while CT still shows `Authorization/Initial` | request **refused** ("A payment is already in progress for this cart") instead of creating a second PI | `processor/src/services/stripe-payment.service.ts:1054-1063,1278-1284` |
| Concurrent `GET /payments` on the same cart version | the loser's `createPayment` hits `DuplicateField` on the Payment key and reuses the winner's open PI (attaching it to the cart if needed and re-stamping `ct_payment_id`). Rethrows if the winner is not reusable or cannot be attached | `processor/src/services/stripe-payment.service.ts:921-934,1086-1185` |
| Enabler receives non-OK from `/payments` | parsed body thrown to `onError` | `enabler/src/dropin/dropin-embedded.ts:136-139,124-126` |
| `stripe.confirmPayment()` fails (card declined, 3DS failed) | error to `onError`. PI exists in Stripe; CT Payment holds `Authorization/Initial`. A retried `GET /payments` reuses the PI while it is open and its configuration matches | `enabler/src/dropin/dropin-embedded.ts:170-189,124-126` |
| `requires_action` other than a bank transfer, or `last_payment_error` | throws to `onError` | `enabler/src/dropin/dropin-embedded.ts:205-216` |
| Any `/confirmPayments` validation fails (unreadable PI, wrong status, cart binding, `ct_payment_id`, `cart_id`, amount/currency) | throw → 400 `{ outcome: 'rejected', error: 'Payment confirmation failed' }`, scalar-only log; CT stays at `Authorization/Initial` | `processor/src/services/stripe-payment.service.ts:1572-1630`; `processor/src/routes/stripe-payment.route.ts:124-143` |
| Synchronous ACH rejection at confirm, e.g. `charge_exceeds_source_limit` | PI never confirms; no order created, cart stays `Active`, Payment `Authorization/Failure`. Async ACH failure instead leaves the order existing and going `Failed` | — |

## Notes

### Sequence

```text
Browser                    Enabler                 Processor               Stripe          CT
  |                          |                         |                      |              |
  | createDropinBuilder()    |                         |                      |              |
  |------------------------->|                         |                      |              |
  |                          | GET /config-element     |                      |              |
  |                          |  + GET /operations/config (parallel)           |              |
  |                          |------------------------>|                      |              |
  |                          |  appearance, layout,    |                      |              |
  |                          |  captureMethod          |                      |              |
  |                          |<------------------------|                      |              |
  |                          | GET /customer/session   |                      |              |
  |                          |------------------------>|                      |              |
  |                          |                         | retrieve/create      |              |
  |                          |                         | Stripe customer ----->|              |
  |                          |                         | create ephemeralKey ->|              |
  |                          |                         | create customerSession>|             |
  |                          |                         | save customerId ----->|              |
  |                          |  {stripeCustomerId,     |<--------------------- |              |
  |                          |   ephemeralKey,         |                      |              |
  |                          |   sessionId}            |                      |              |
  |                          |<------------------------|                      |              |
  |                          | Stripe.loadStripe()     |                      |              |
  |                          | elements.create()       |                      |              |
  |                          | paymentElement.mount()  |                      |              |
  |   Payment Element shown  |                         |                      |              |
  |<-------------------------|                         |                      |              |
  |                          |                         |                      |              |
  | (user fills card data)   |                         |                      |              |
  |                          |                         |                      |              |
  | click Pay button         |                         |                      |              |
  |------------------------->|                         |                      |              |
  |                          | elements.submit()       |                      |              |
  |                          | (validates form)        |                      |              |
  |                          | GET /payments           |                      |              |
  |                          |------------------------>|                      |              |
  |                          |                         | getCart()            |              |
  |                          |                         |---------------------------------------------->|
  |                          |                         | reuse check: open PI on cart?         |     |
  |                          |                         |   yes -> return it, skip the rest     |       |
  |                          |                         | paymentIntents.create()               |       |
  |                          |                         |---------------------->|               |       |
  |                          |                         | createPayment()  (key pi-create-...)  |       |
  |                          |                         |---------------------------------------------->|
  |                          |                         | addPayment(cart)      |               |       |
  |                          |                         |---------------------------------------------->|
  |                          |                         | paymentIntents.update() (metadata:    |       |
  |                          |                         |   ct_payment_id = ctPayment.id)       |       |
  |                          |                         |---------------------->|               |       |
  |                          |  {clientSecret}         |                      |              |
  |                          |<------------------------|                      |              |
  |                          | stripe.confirmPayment() |                      |              |
  |                          |   (handles 3DS if needed, see 3DS note)        |              |
  |                          |------------------------>Stripe confirms PI ---->|              |
  |                          |                         |                      |              |
  |                          | POST /confirmPayments/:id                      |              |
  |                          |------------------------>|                      |              |
  |                          |                         | paymentIntents.retrieve()            |
  |                          |                         |---------------------->|              |
  |                          |                         | validation (6 checks, step 21)       |
  |                          |                         | updatePayment(AUTHORIZED)            |
  |                          |                         |---------------------------------------------->|
  |                          |  {success}              |                      |              |
  |                          |<------------------------|                      |              |
  | onComplete({isSuccess})  |                         |                      |              |
  |<-------------------------|                         |                      |              |
```

### Decision points

| Point | Condition | Path |
|---|---|---|
| Customer session | `cart.customerId` exists | Session returned → saved methods enabled |
| Customer session | No `customerId` (guest) | 204 → no saved methods |
| Flow type | `pi_first` (Blik) | PI created during setup; Elements bound to its client secret; no `setup_future_usage` |
| Reuse check | Open, matching PI already on the cart | Reused; no new PI/Payment |
| Reuse check | Settled / in-progress PI with CT still `Initial` | Request refused |
| Validation | All checks pass | `Authorization/Success` (200) or `Authorization/Pending` (202) |
| Validation | Any check fails | 400 `rejected`; CT stays `Authorization/Initial` |
| 3DS required | Stripe returns `requires_action` | Stripe.js shows the challenge (or redirects); resume after authentication |

### 3DS / redirect note

`stripe.confirmPayment()` handles 3DS transparently. With `redirect: 'if_required'` a card challenge normally completes in a modal and the enabler continues to step 20. If the method redirects:

1. Stripe redirects the user to the bank's page
2. After authentication, Stripe redirects back to the merchant return URL (request context, else `MERCHANT_RETURN_URL`), with `cartId` and `paymentReference` appended — `enabler/src/dropin/dropin-embedded.ts:152-154`
3. The storefront must call `POST /confirmPayments/:id` again after the redirect — the enabler does not resume
4. The backend validates the now-succeeded PI and updates CT

### Other notes

- **Step 1 detail:** the enabler calls `GET /customer/session` for every cart; the "if cart has `customerId`" decision is taken by the processor, which answers 204 (`processor/src/routes/stripe-payment.route.ts:59-65`; `processor/src/services/stripe-payment.service.ts:626-631`).
- `setup_future_usage` is sent only when a Stripe customer is bound; under `pi_first` it is never sent, at either resolution site (`processor/src/services/stripe-payment.service.ts:1464-1468,1359-1364,1890-1893`). A recurring cart forces `off_session` (`:684-687`).
- Both behavior-rule resolution sites (`initializeCartPayment` and `createPaymentIntentStripe`) must resolve identically — Stripe validates the deferred element options against the retrieved intent (`business-rules/payment-behavior-rules.md` Rule 2 "Both resolution sites must agree, always").
- Webhook-side recording is independent; with the confirm gate it yields one `Authorization/Success` and one `Charge/Success`.
