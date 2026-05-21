# Workflow: Express Checkout (Apple Pay / Google Pay)

**Trigger:** Storefront renders Express Checkout buttons (Apple Pay, Google Pay, etc.) before or during checkout.
**Actors:** Browser (Enabler), Processor, Stripe API, CT API, Merchant storefront callbacks.
**Outcome:** CT Payment in AUTHORIZED state, payment collected via native wallet UI.

---

## Initialization Paths

Express Checkout has two initialization paths that differ in when the CT session is resolved:

| Path | Class | Session at render time | Elements at render time | Customer binding on PI |
| --- | --- | --- | --- | --- |
| `_SetupExpress` (deferred) | `DropinExpressBuilder` | No — obtained in `onPayButtonClick` | No — created lazily inside `init()` | Never — one-shot PI |
| `_Setup` (upfront) | `DropinExpressSetupBuilder` | Yes — passed to `createExpressBuilder()` | Yes — created in `getElements()` with `customerOptions` and `setupFutureUsage` | Yes, when CT customer has a Stripe ID |

The two paths diverge at initialization and converge at `GET /payments` / `confirmPayment`.

---

## Flow — `_SetupExpress` (Deferred Session)

```text
Browser / Storefront        Enabler                 Processor              Stripe          CT
  |                           |                         |                     |              |
  | createExpressBuilder()    |                         |                     |              |
  |-------------------------->|                         |                     |              |
  |                           | POST /express-config    |                     |              |
  |                           | (CORS, no session)      |                     |              |
  |                           |------------------------>|                     |              |
  |                           |  {publishableKey,       |                     |              |
  |                           |   appearance,           |                     |              |
  |                           |   expressOptions}       |                     |              |
  |                           |<------------------------|                     |              |
  |                           | Stripe.loadStripe()     |                     |              |
  |                           | ExpressCheckoutElement  |                     |              |
  |                           | .mount() (no Elements   |                     |              |
  |                           |  instance yet — deferred)|                    |              |
  |   Express buttons shown   |                         |                     |              |
  |<--------------------------|                         |                     |              |
  |                           |                         |                     |              |
  | (user taps Apple Pay)     |                         |                     |              |
  |-------------------------->|                         |                     |              |
  |                           | onPayButtonClick()      |                     |              |
  |                           |-- callback to merchant ->|                    |              |
  |                           |                         | (merchant creates   |              |
  |                           |                         |  session, returns   |              |
  |                           |                         |  {sessionId})       |              |
  |                           |<-- {sessionId} ---------|                     |              |
  |                           | Creates Elements with   |                     |              |
  |                           | sessionId now available |                     |              |
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
  |                           |<-- updated totals -------|                    |              |
  |                           | Stripe.updateWith()     |                     |              |
  |   Wallet updates totals   |                         |                     |              |
  |                           |                         |                     |              |
  | (Stripe requests methods) |                         |                     |              |
  |-------------------------->|                         |                     |              |
  |                           | getShippingMethods()    |                     |              |
  |                           |-- callback to merchant ->|                    |              |
  |                           |<-- [{id, label, amount}]|                     |              |
  |   Shipping options shown  |                         |                     |              |
  |                           |                         |                     |              |
  | (user selects method)     |                         |                     |              |
  |-------------------------->|                         |                     |              |
  |                           | onShippingMethodSelected()                    |              |
  |                           |-- callback to merchant ->|                    |              |
  |                           |<-- updated totals -------|                    |              |
  |                           | Stripe.updateWith()     |                     |              |
  |   Wallet updates total    |                         |                     |              |
  |                           |                         |                     |              |
  | (user authorizes payment) |                         |                     |              |
  |-------------------------->|                         |                     |              |
  |                           | onPaymentSubmit()       |                     |              |
  |                           |-- callback to merchant  |                     |              |
  |                           |   (final address,email) |                     |              |
  |                           |<-- ok ------------------|                     |              |
  |                           | GET /payments           |                     |              |
  |                           | (x-express-checkout:true)                     |              |
  |                           |------------------------>|                     |              |
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
  |                           |                         | 4-point validation  |              |
  |                           |                         | updatePayment(AUTHORIZED)          |
  |                           |                         |------------------------------------------>|
  |                           | onComplete()            |                     |              |
  |   Wallet closes, success  |                         |                     |              |
```

---

## Steps Detail

### 1. Button Initialization (no session needed)

- Enabler calls `POST /express-config` with CORS auth (no session header)
- Receives publishable key, appearance, express element options
- Loads Stripe SDK and mounts `ExpressCheckoutElement`
- Elements instance creation is **deferred** until user taps a button

### 2. Session Resolution (on wallet open)

- User taps Apple Pay / Google Pay
- `onPayButtonClick` callback is invoked on the merchant storefront
- Merchant creates a session and returns `{ sessionId }`
- Enabler creates the Stripe Elements instance with the session
- Wallet sheet opens with `initialAmount` passed to the element

### 3. Shipping Address Selection

- User selects or confirms shipping address in wallet
- `onShippingAddressSelected` callback fires with the address
- Merchant updates cart with the new address and returns updated totals
- Enabler calls `stripe.updateWith()` to refresh the wallet display

### 4. Shipping Method Selection

- Stripe wallet requests available shipping methods
- `getShippingMethods` callback returns available methods with amounts
- User selects a method
- `onShippingMethodSelected` callback fires
- Merchant updates cart; enabler updates wallet totals

### 5. Payment Submission

- User authorizes in wallet (Face ID, fingerprint, etc.)
- `onPaymentSubmit` callback fires with final shipping address, billing address, customer email
- Merchant updates cart with final data
- Enabler calls `GET /payments` with `x-express-checkout: true` header
- PI created **without** shipping params (wallet owns shipping)
- Flow continues identical to standard payment from step 3 onward

---

## Flow — `_Setup` (Upfront Session)

```text
Browser / Storefront        Enabler                 Processor              Stripe          CT
  |                           |                         |                     |              |
  | createExpressBuilder()    |                         |                     |              |
  | (sessionId provided)      |                         |                     |              |
  |-------------------------->|                         |                     |              |
  |                           | POST /express-config    |                     |              |
  |                           | (CORS, no session)      |                     |              |
  |                           |------------------------>|                     |              |
  |                           |  {publishableKey,       |                     |              |
  |                           |   appearance,           |                     |              |
  |                           |   expressOptions}       |                     |              |
  |                           |<------------------------|                     |              |
  |                           | GET /customer/session   |                     |              |
  |                           | (session auth)          |                     |              |
  |                           |------------------------>|                     |              |
  |                           |  {stripeCustomerId,     |                     |              |
  |                           |   customerSessionSecret}|                     |              |
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
  |                           |                         | 4-point validation  |              |
  |                           |                         | updatePayment(AUTHORIZED)          |
  |                           |                         |------------------------------------------>|
  |                           | onComplete()            |                     |              |
  |   Wallet closes, success  |                         |                     |              |
```

---

## Steps Detail — `_Setup` Path

### 1. Button Initialization (session available)

- Merchant passes `sessionId` to `createExpressBuilder()`
- Enabler calls `POST /express-config` (CORS, no session) to get publishable key and options
- Enabler calls `GET /customer/session` (with session auth) to resolve the Stripe customer; receives `stripeCustomerId` and `customerSessionClientSecret`
- `baseOptions.stripeCustomerId` is set from the customer session response
- Enabler calls `getElements()` — creates Stripe Elements with `customerOptions`, `setupFutureUsage`, and `customerSessionClientSecret`
- `ExpressCheckoutElement` is mounted; buttons appear immediately

### 2. Wallet Open

- User taps Apple Pay / Google Pay
- `onPayButtonClick` callback is invoked; merchant returns the existing `{ sessionId }` (already available)
- Wallet sheet opens

### 3–5. Shipping and Payment (identical to `_SetupExpress`)

- Shipping address selection, method selection, and payment authorization follow the same callback sequence as the deferred path

### 6. PI Creation with Customer Binding

- Enabler calls `GET /payments` with both `x-express-checkout: true` and `x-express-customer-session: true` headers
- Processor reads `x-express-customer-session: true` and sets `isExpressCustomerSession = true`
- `expressWithCustomer = expressCheckout && Boolean(stripeCustomerId) && expressCustomerSession` evaluates to `true`
- PI is created **with** `customer` and `setup_future_usage` — matching the Elements configuration
- Flow continues identical to standard payment from confirmation onward

---

## Session Race Condition Handling

The enabler tracks a `sessionInitGeneration` counter to handle the case where the user opens and dismisses the wallet quickly before `onPayButtonClick` resolves:

- Each wallet open increments the generation counter
- The Elements instance is only created if the generation matches when the callback resolves
- Stale sessions from dismissed wallets are ignored

---

## Decision Points

| Point | Condition | Path |
| --- | --- | --- |
| Session at render time | Session provided to `createExpressBuilder()` | `_Setup` path — Elements created upfront with customer |
| Session at render time | No session provided | `_SetupExpress` path — Elements created lazily in `onPayButtonClick` |
| `x-express-customer-session` header | `true` and `stripeCustomerId` resolved | PI bound with `customer` + `setup_future_usage` |
| `x-express-customer-session` header | Absent or `stripeCustomerId` not resolved | One-shot PI, no customer binding |
| Session availability (`_SetupExpress`) | `onPayButtonClick` returns `{sessionId}` | Create Elements, open wallet |
| Session availability (`_SetupExpress`) | Callback times out or fails | Wallet fails to open; `onError` called |
| Shipping address | Merchant returns updated totals | Wallet refreshes |
| Shipping address | Merchant returns error | Wallet shows error; user cannot proceed |
| Payment submit | Wallet authorization succeeds | Continue to PI creation |
| Payment submit | Wallet authorization fails | `onError` called; PI never created |

---

## Error Paths

| Error | Cause | CT State |
| --- | --- | --- |
| `/express-config` fails | Processor unavailable | Buttons not shown |
| `GET /customer/session` fails (`_Setup`) | Processor error or no customer | `stripeCustomerId` absent; PI created without customer binding |
| `onPayButtonClick` fails | Merchant callback error | Wallet never opens |
| `onShippingAddressSelected` fails | Cart update error | Wallet shows error |
| `GET /payments` fails | PI/CT creation error | No CT Payment created |
| `confirmPayment` fails | `setup_future_usage` mismatch | Stripe rejects; no CT update |
| Wallet authorization fails | Declined / user cancel | No CT Payment created |
