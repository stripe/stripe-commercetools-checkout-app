# Workflow: Express Checkout (Apple Pay / Google Pay)

**Trigger:** Storefront calls `createExpressBuilder('dropin')` and mounts the Express Checkout Element (Apple Pay, Google Pay, Link, etc.) before or during checkout; the shopper picks a wallet.
**Modules involved:** enabler, processor.
**Actors:** Browser (Enabler), Processor, Stripe API, CT API, Merchant storefront callbacks.
**Outcome:** a wallet payment confirmed against a PaymentIntent created **without shipping**, recorded like any drop-in payment: CT Payment in `Authorization/Success`, payment collected via the native wallet UI.

Creation and confirmation on the processor are the same code as `process-standard-payment.md` steps 10–17 and 21–24; only what differs is repeated here.

## Initialization paths

Express Checkout has two initialization paths that differ in when the CT session is resolved:

| Path | Class | Session at render time | Elements | Customer binding on PI |
| --- | --- | --- | --- | --- |
| `_SetupExpress` (deferred) | `StripeExpressBuilder` over `_SetupExpress` base options | No — obtained from `onPayButtonClick` after the wallet opens | Created in the component's `init()` (at `mount()`) with `initialAmount` | Never — one-shot PI |
| `_Setup` (upfront) | `StripeExpressBuilder` over `_Setup(skipPiFirst)` base options | Yes — passed to the `Enabler` | Created in `_Setup` via `getElements()` with `customerOptions` and `setupFutureUsage`; `init()` updates the amount | Yes, when the CT customer has a Stripe ID |

The two paths diverge at initialization and converge at `GET /payments` / `confirmPayment` — `enabler/src/payment-enabler/payment-enabler-mock.ts:233-252`.

## Happy Path

### `_SetupExpress` (deferred session)

1. No `sessionId`: `_SetupExpress` calls `POST /express-config` and receives publishable key, environment, capture method, appearance and express element options; loads Stripe.js; `elements` stays `null` — `enabler/src/payment-enabler/payment-enabler-mock.ts:311-355`; `processor/src/routes/stripe-payment.route.ts:429-448`; `processor/src/services/stripe-payment.service.ts:213-222`
2. `build({ initialAmount })` validates that `centAmount` is a number and `currencyCode` is set — `enabler/src/express/dropin-express.ts:53-66`
3. `mount()` → `init()`: creates Elements now (`mode: 'payment'`, `initialAmount`, capture method, appearance, locale) and the `expressCheckout` element with shipping and billing address required plus the allow-listed express options; binds listeners once — `enabler/src/express/dropin-express.ts:111-166`
4. User taps a wallet → `click`: resolves **synchronously** with one line item `Total = initialAmount` (Stripe's ~1 s limit), then starts `onPayButtonClick` in the background; a generation counter discards a stale result — `enabler/src/express/dropin-express.ts:171-212`
5. Shipping address selected → `ensureSessionId()` (awaits the in-flight `onPayButtonClick`, or calls it), host `onShippingAddressSelected`, host `getShippingMethods`, the **first** rate is applied via host `onShippingMethodSelected`, then `GET /express-payment-data` and `elements.update({ amount })`; the event resolves with `shippingRates` and line items — `enabler/src/express/dropin-express.ts:257-319,238-251`; `enabler/src/express/base.ts:22-47`; `processor/src/services/stripe-payment.service.ts:1789-1853`
6. Shipping rate changed → host `onShippingMethodSelected`, `GET /express-payment-data`, `elements.update({ amount })`, resolve with line items — `enabler/src/express/dropin-express.ts:327-347`
7. User authorizes → `confirm` → `handlePaymentConfirm`: ignored if a confirm is in flight or one already completed on this component — `enabler/src/express/dropin-express.ts:214-216,405-415`
8. `ensureSessionId()`, then `elements.submit()` — `enabler/src/express/dropin-express.ts:417-424`
9. Host `onPaymentSubmit` with shipping address, billing address and email read from the confirm event — only the parts present; skipped when all are empty — `enabler/src/express/dropin-express.ts:426-442,372-391`
10. `GET /payments` with `x-session-id`, `x-express-checkout: true` (and `x-express-customer-session: true` only when `baseOptions.stripeCustomerId` is set — never on this path) — `enabler/src/express/dropin-express.ts:444-445,493-506,590-602`. Processor: same create path as the drop-in, but the PI is created **without** shipping and without customer binding; the reuse check applies — `processor/src/services/stripe-payment.service.ts:812-844,1464-1480`
11. `stripe.confirmPayment({ elements, clientSecret, return_url, billing_details?, redirect: 'if_required' })` — `enabler/src/express/dropin-express.ts:447-456,514-558`
12. `POST /confirmPayments/{paymentReference}` — `enabler/src/express/dropin-express.ts:458-462,566-579`. Processor validation and write as in `process-standard-payment.md` steps 21–24
13. On success (any `response.ok` from `/confirmPayments`), `onComplete({ isSuccess: true, paymentReference })` is reported — `enabler/src/express/dropin-express.ts:465-469,581`
14. `finally`: `confirmInFlight` is reset — `enabler/src/express/dropin-express.ts:480-482`

### `_Setup` (upfront session)

1. Merchant passes `sessionId` to the `Enabler`; `createExpressBuilder` runs `_Setup(options, { skipPiFirst: true })` — `enabler/src/payment-enabler/payment-enabler-mock.ts:130-135,236-238`
2. `_Setup` calls `GET /config-element/payment` and `GET /operations/config` with `X-Session-Id` (not `/express-config`), loads Stripe.js, and calls `GET /customer/session`; the response is `{ stripeCustomerId, ephemeralKey, sessionId }` — `enabler/src/payment-enabler/payment-enabler-mock.ts:137-145,357-368,433-444`
3. `baseOptions.stripeCustomerId` is set from that response — `enabler/src/payment-enabler/payment-enabler-mock.ts:180`
4. `getElements()` creates Elements with `customerOptions` (customer + ephemeral key), `setupFutureUsage`, `customerSessionClientSecret` (= the response's `sessionId`), amount, currency and capture method — `enabler/src/payment-enabler/payment-enabler-mock.ts:160-166,284-299`
5. `mount()` → `init()` updates the existing Elements to `initialAmount` (locale is not passed to `update()`), creates and mounts the `expressCheckout` element; buttons appear immediately — `enabler/src/express/dropin-express.ts:116-123,137-142,145-166`
6. Wallet open: `click` resolves and calls `onPayButtonClick`; the merchant returns the existing `{ sessionId }` — `enabler/src/express/dropin-express.ts:181-212`
7. Shipping and payment: identical to `_SetupExpress` steps 5–9
8. `GET /payments` with both `x-express-checkout: true` and `x-express-customer-session: true` — `enabler/src/express/dropin-express.ts:595-600`
9. Processor: `isExpressCustomerSession = true`; `expressWithCustomer = expressCheckout && Boolean(stripeCustomerId) && expressCustomerSession`, where `stripeCustomerId` is read from the **CT customer's custom field**, not from the header — `processor/src/routes/stripe-payment.route.ts:85-88`; `processor/src/services/stripe-payment.service.ts:812-817,1372-1378`
10. PI created **with** `customer` and `setup_future_usage` — matching the Elements configuration — and still without shipping — `processor/src/services/stripe-payment.service.ts:1461-1480`
11. Confirmation continues as `_SetupExpress` steps 11–14

## Error Paths

| Condition | Behavior | File |
| --- | --- | --- |
| `/express-config` 403 (Origin not allowed) | `_SetupExpress` throws "Unauthorized error fetching express config"; buttons not shown | `enabler/src/payment-enabler/payment-enabler-mock.ts:319-324`; `processor/src/libs/fastify/cors/cors.ts:10-32` |
| `/express-config` fails otherwise (processor unavailable) | throws "Not able to initialize Express Checkout"; buttons not shown | `enabler/src/payment-enabler/payment-enabler-mock.ts:323` |
| `initialAmount` missing or malformed | `build()` throws | `enabler/src/express/dropin-express.ts:54-59` |
| `GET /customer/session` returns 204 (`_Setup`) | no `stripeCustomerId`; no `x-express-customer-session`; PI created without customer binding | `enabler/src/payment-enabler/payment-enabler-mock.ts:438-441`; `enabler/src/express/dropin-express.ts:598-600` |
| `onPayButtonClick` fails in the background (merchant callback error) | constructor `onError("Failed to get session ID for Express Checkout.")`; the wallet sheet is already open | `enabler/src/express/dropin-express.ts:191-194` |
| No session when a callback needs one | `ensureSessionId` calls `onPayButtonClick`; on failure `onError` and throw | `enabler/src/express/dropin-express.ts:257-275` |
| `onShippingAddressSelected` / `getShippingMethods` / rate update fails | `onError("Error updating shipping address."/"…shipping method.")`, `reject()` | `enabler/src/express/dropin-express.ts:314-318,342-346` |
| No shipping methods returned | `reject()`; wallet shows an error and the user cannot proceed | `enabler/src/express/dropin-express.ts:296-313` |
| Wallet sheet dismissed | session state reset; constructor `onError` with an `Error` whose `name` is `'CANCEL'` | `enabler/src/express/dropin-express.ts:218-220,354-359,105-109` |
| Duplicate `confirm` from the wallet (in flight or after success) | ignored on this component | `enabler/src/express/dropin-express.ts:406-415` |
| A PI on the cart is already settling while CT shows `Authorization/Initial` | `GET /payments` refused → confirm-stage error below | `processor/src/services/stripe-payment.service.ts:1054-1063` |
| Any confirm-stage error — `elements.submit()`, `onPaymentSubmit`, `GET /payments`, a Stripe decline, an invalid return URL, `/confirmPayments` non-OK | `event.paymentFailed({ reason: 'fail' })` closes the wallet sheet; the host receives `onError('Error during payment confirmation.')` and `onComplete({ isSuccess: false })` | `enabler/src/express/dropin-express.ts:470-479,500-503,539-555,577-579` |
| `GET /payments` fails (PI/CT creation error) | confirm-stage error above; no CT Payment created when the failure is before `createPayment` | `processor/src/services/stripe-payment.service.ts:878-880` |
| `confirmPayment` fails on a `setup_future_usage` mismatch between Elements and the PI | Stripe rejects; confirm-stage error; CT Payment stays `Authorization/Initial` | `enabler/src/express/dropin-express.ts:539-541` |
| Wallet authorization fails before `confirm` (declined in the sheet / user cancel) | `confirm` never fires; no CT Payment created | Stripe-side |

## Notes

### Sequence — `_SetupExpress` (deferred session)

```text
Browser / Storefront        Enabler                 Processor              Stripe          CT
  |                           |                         |                     |              |
  | createExpressBuilder()    |                         |                     |              |
  |-------------------------->|                         |                     |              |
  |                           | POST /express-config    |                     |              |
  |                           |------------------------>|                     |              |
  |                           |  {publishableKey,       |                     |              |
  |                           |   appearance,           |                     |              |
  |                           |   expressOptions}       |                     |              |
  |                           |<------------------------|                     |              |
  |                           | Stripe.loadStripe()     |                     |              |
  |                           | mount() -> init():      |                     |              |
  |                           |  elements({initialAmount})                    |              |
  |                           |  ExpressCheckoutElement |                     |              |
  |                           |  .mount()               |                     |              |
  |   Express buttons shown   |                         |                     |              |
  |<--------------------------|                         |                     |              |
  |                           |                         |                     |              |
  | (user taps Apple Pay)     |                         |                     |              |
  |-------------------------->|                         |                     |              |
  |                           | click: resolve(Total)   |                     |              |
  |                           | onPayButtonClick() in background              |              |
  |                           |-- callback to merchant ->|                    |              |
  |                           |                         | (merchant creates   |              |
  |                           |                         |  session, returns   |              |
  |                           |                         |  {sessionId})       |              |
  |                           |<-- {sessionId} ---------|                     |              |
  |                           | currentSessionId set    |                     |              |
  |                           |                         |                     |              |
  |   Wallet sheet opens      |                         |                     |              |
  |   (shows initial amount)  |                         |                     |              |
  |                           |                         |                     |              |
  | (user selects address)    |                         |                     |              |
  |-------------------------->|                         |                     |              |
  |                           | onShippingAddressSelected()                   |              |
  |                           |-- callback to merchant ->|                    |              |
  |                           |   (merchant updates     |                     |              |
  |                           |    cart shipping addr)  |                     |              |
  |                           | getShippingMethods()    |                     |              |
  |                           |<-- [{id, label, amount}]|                     |              |
  |                           | onShippingMethodSelected(first rate)          |              |
  |                           | GET /express-payment-data                     |              |
  |                           |------------------------>|                     |              |
  |                           |<-- totals, line items --|                     |              |
  |                           | elements.update({amount})                     |              |
  |                           | event.resolve({shippingRates, lineItems})     |              |
  |   Wallet updates totals   |                         |                     |              |
  |                           |                         |                     |              |
  | (user selects method)     |                         |                     |              |
  |-------------------------->|                         |                     |              |
  |                           | onShippingMethodSelected()                    |              |
  |                           |-- callback to merchant ->|                    |              |
  |                           | GET /express-payment-data, elements.update    |              |
  |                           | event.resolve({lineItems})                    |              |
  |   Wallet updates total    |                         |                     |              |
  |                           |                         |                     |              |
  | (user authorizes payment) |                         |                     |              |
  |-------------------------->|                         |                     |              |
  |                           | confirm (guarded: once) |                     |              |
  |                           | elements.submit()       |                     |              |
  |                           | onPaymentSubmit()       |                     |              |
  |                           |-- callback to merchant  |                     |              |
  |                           |   (final address,email) |                     |              |
  |                           |<-- ok ------------------|                     |              |
  |                           | GET /payments           |                     |              |
  |                           | (x-express-checkout:true)                     |              |
  |                           |------------------------>|                     |              |
  |                           |                         | reuse check, else   |              |
  |                           |                         | paymentIntents.create()            |
  |                           |                         | (NO shipping params)|              |
  |                           |                         |-------------------->|              |
  |                           |                         | createPayment()     |              |
  |                           |                         |------------------------------------------>|
  |                           |                         | addPayment()        |              |
  |                           |                         |------------------------------------------>|
  |                           |  {clientSecret}         |                     |              |
  |                           |<------------------------|                     |              |
  |                           | stripe.confirmPayment() |                     |              |
  |                           |------------------------>Stripe confirms PI --->|              |
  |                           | POST /confirmPayments/:id                     |              |
  |                           |------------------------>|                     |              |
  |                           |                         | validation (6 checks)              |
  |                           |                         | updatePayment(AUTHORIZED)          |
  |                           |                         |------------------------------------------>|
  |                           | onComplete()            |                     |              |
  |   Wallet closes, success  |                         |                     |              |
```

### Sequence — `_Setup` (upfront session)

```text
Browser / Storefront        Enabler                 Processor              Stripe          CT
  |                           |                         |                     |              |
  | createExpressBuilder()    |                         |                     |              |
  | (sessionId provided)      |                         |                     |              |
  |-------------------------->|                         |                     |              |
  |                           | GET /config-element/payment                   |              |
  |                           |  + GET /operations/config (session auth)      |              |
  |                           |------------------------>|                     |              |
  |                           |  {publishableKey,       |                     |              |
  |                           |   appearance, cartInfo, |                     |              |
  |                           |   setupFutureUsage}     |                     |              |
  |                           |<------------------------|                     |              |
  |                           | GET /customer/session   |                     |              |
  |                           | (session auth)          |                     |              |
  |                           |------------------------>|                     |              |
  |                           |  {stripeCustomerId,     |                     |              |
  |                           |   ephemeralKey,         |                     |              |
  |                           |   sessionId}            |                     |              |
  |                           |<------------------------|                     |              |
  |                           | Stripe.loadStripe()     |                     |              |
  |                           | getElements() with      |                     |              |
  |                           | customerOptions +       |                     |              |
  |                           | setupFutureUsage        |                     |              |
  |                           | ExpressCheckoutElement  |                     |              |
  |                           | .mount()                |                     |              |
  |   Express buttons shown   |                         |                     |              |
  |<--------------------------|                         |                     |              |
  |                           |                         |                     |              |
  | (user taps Apple Pay)     |                         |                     |              |
  |-------------------------->|                         |                     |              |
  |                           | onPayButtonClick()      |                     |              |
  |                           |-- callback to merchant ->|                    |              |
  |                           |   (session already      |                     |              |
  |                           |    exists, return it)   |                     |              |
  |                           |<-- {sessionId} ---------|                     |              |
  |                           |                         |                     |              |
  |   Wallet sheet opens      |                         |                     |              |
  |                           |                         |                     |              |
  | (user selects address,    |                         |                     |              |
  |  method, authorizes)      |                         |                     |              |
  |   [same as _SetupExpress] |                         |                     |              |
  |                           |                         |                     |              |
  |                           | GET /payments           |                     |              |
  |                           | x-express-checkout: true|                     |              |
  |                           | x-express-customer-     |                     |              |
  |                           | session: true           |                     |              |
  |                           |------------------------>|                     |              |
  |                           |                         | paymentIntents.create()            |
  |                           |                         | customer + setup_   |              |
  |                           |                         | future_usage bound  |              |
  |                           |                         | (expressWithCustomer|              |
  |                           |                         |  = true)            |              |
  |                           |                         |-------------------->|              |
  |                           |                         | createPayment()     |              |
  |                           |                         |------------------------------------------>|
  |                           |                         | addPayment()        |              |
  |                           |                         |------------------------------------------>|
  |                           |  {clientSecret}         |                     |              |
  |                           |<------------------------|                     |              |
  |                           | stripe.confirmPayment() |                     |              |
  |                           |------------------------>Stripe confirms PI --->|              |
  |                           | POST /confirmPayments/:id                     |              |
  |                           |------------------------>|                     |              |
  |                           |                         | validation (6 checks)              |
  |                           |                         | updatePayment(AUTHORIZED)          |
  |                           |                         |------------------------------------------>|
  |                           | onComplete()            |                     |              |
  |   Wallet closes, success  |                         |                     |              |
```

### Stale session handling

The enabler tracks a `sessionInitGeneration` counter to handle the case where the user opens and dismisses the wallet quickly before `onPayButtonClick` resolves — `enabler/src/express/dropin-express.ts:83,105-109,181-201`:

- Each wallet open (`click`) and each cancel increments the generation counter and resets `currentSessionId` to the constructor's session id
- The session id returned by `onPayButtonClick` is only stored if the generation still matches when the callback resolves
- Stale sessions from dismissed wallets are ignored

### Decision points

| Point | Condition | Path |
| --- | --- | --- |
| Session at render time | Session provided to the `Enabler` | `_Setup` path — Elements created upfront with customer |
| Session at render time | No session provided | `_SetupExpress` path — Elements created in `init()` with `initialAmount`; session obtained from `onPayButtonClick` |
| `x-express-customer-session` header | `true` and the CT customer has a Stripe customer id | PI bound with `customer` + `setup_future_usage` |
| `x-express-customer-session` header | Absent, or no Stripe customer id on the CT customer | One-shot PI, no customer binding |
| Session availability (`_SetupExpress`) | `onPayButtonClick` returns `{sessionId}` | Session stored; used by later callbacks and `GET /payments` |
| Session availability (`_SetupExpress`) | Callback fails | `onError`; a later callback retries via `ensureSessionId` |
| Shipping address | Methods returned | First rate applied; wallet refreshes |
| Shipping address | Merchant callback throws / no methods | `reject()`; wallet shows error; user cannot proceed |
| Confirm | Already in flight or completed | Ignored |
| Payment submit | Wallet authorization succeeds | Continue to PI creation |
| Payment submit | Wallet authorization fails | `confirm` never fires; PI never created |

### Other notes

- Confirm against the commercetools Payment's transactions before telling the shopper the payment failed (`host-integration.md`, sections "Read the Payment to decide the outcome", "Express — what each failure does to the wallet", "Express — outcome callbacks").
- A Stripe customer is attached only with `x-express-customer-session` (`business-rules/payment-lifecycle.md` Rule 7 "Express Checkout with a known customer binds `customer` and `setup_future_usage` on the PI"). Express PIs never carry shipping (`business-rules/payment-lifecycle.md` Rule 5).
- The processor treats a request as Express only when `x-express-checkout` is exactly the string `'true'` or `'1'` — case-sensitive, so `'TRUE'` or `'yes'` is read as a drop-in and the PaymentIntent gets shipping. `x-express-customer-session` accepts only `'true'` (`processor/src/routes/stripe-payment.route.ts:85-87`). The enabler sends `'true'` (`enabler/src/express/dropin-express.ts:596`); the `'1'` form matters only to a host calling `GET /payments` itself.
- The upfront path always skips `pi_first`: Express Elements need `{ mode, amount, currency }` so that `init()` can call `elements.update` (`enabler/src/payment-enabler/payment-enabler-mock.ts:125-135`).
