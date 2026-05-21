# Workflow: Standard Embedded Payment

**Trigger:** Customer reaches checkout and mounts the Stripe Payment Element.
**Actors:** Browser (Enabler), Processor, Stripe API, CT API.
**Outcome:** CT Payment in AUTHORIZED state, Stripe PI in `succeeded` or `requires_capture` state.

---

## Flow

```text
Browser                    Enabler                 Processor               Stripe          CT
  |                          |                         |                      |              |
  | createDropinBuilder()    |                         |                      |              |
  |------------------------->|                         |                      |              |
  |                          | GET /config-element     |                      |              |
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
  |                          |                         | paymentIntents.create()               |       |
  |                          |                         |---------------------->|               |       |
  |                          |                         | paymentIntents.update() (metadata)    |       |
  |                          |                         |---------------------->|               |       |
  |                          |                         | createPayment()       |               |       |
  |                          |                         |---------------------------------------------->|
  |                          |                         | addPayment(cart)      |               |       |
  |                          |                         |---------------------------------------------->|
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
  |                          |                         | 4-point validation    |              |
  |                          |                         | updatePayment(AUTHORIZED)            |
  |                          |                         |---------------------------------------------->|
  |                          |  {success}              |                      |              |
  |                          |<------------------------|                      |              |
  | onComplete({isSuccess})  |                         |                      |              |
  |<-------------------------|                         |                      |              |
```

---

## Steps Detail

### 1. Initialization

- Enabler fetches config from `/config-element` (appearance, layout, capture method, billing address setting)
- If cart has `customerId`: fetches customer session from `/customer/session` (enables saved payment methods)
- Stripe Elements created with customer data and appearance config

### 2. Payment Intent Creation (`GET /payments`)

- Processor reads cart from CT to get amount and currency
- Creates Stripe PI with: amount, currency, capture method, customer (if any), setup_future_usage (if configured), tax hooks (if applicable)
- Makes a **second Stripe call** (`paymentIntents.update()`) to write `ct_payment_id` into the PI's metadata — the PI is created first, then the metadata is patched separately. If this second call fails, the CT Payment exists but the PI has no `ct_payment_id` in metadata; webhook events for that PI will be silently skipped
- Creates CT Payment object with PENDING AUTHORIZATION transaction
- Associates CT Payment to cart via `addPayment()`
- Returns `clientSecret` to enabler

### 3. Stripe Confirmation (`stripe.confirmPayment()`)

- Enabler calls Stripe JS SDK to confirm the PI
- Stripe handles: 3DS authentication, redirect-based methods, card validation
- On success: PI moves to `succeeded` (automatic capture) or `requires_capture` (manual)
- On failure: Stripe returns error; `onError` callback is invoked

### 4. Backend Confirmation (`POST /confirmPayments/:id`)

- Enabler sends PI ID to processor
- Processor retrieves PI from Stripe
- Runs 4-point validation (see `business-rules/payment-lifecycle.md` Rule 2)
- Updates CT Payment: AUTHORIZATION → SUCCESS (or CHARGE → SUCCESS for automatic capture)
- Returns success to enabler

### 5. Async Webhook (parallel path)

- Stripe sends `payment_intent.succeeded` or `charge.succeeded` webhook
- Processor records additional transaction data in CT (CHARGE:SUCCESS or AUTHORIZATION:SUCCESS)
- Stores payment method if customer opted in; creates recurring job if applicable

---

## Decision Points

| Point | Condition | Path |
|---|---|---|
| Customer session | `cart.customerId` exists | Fetch session → enable saved methods |
| Customer session | No `customerId` (guest) | Skip session → no saved methods |
| 4-point validation | All checks pass | Update CT to AUTHORIZED |
| 4-point validation | Any check fails | Return 400; CT stays in PENDING |
| 3DS required | Stripe returns `requires_action` | Redirect user; resume after authentication |

---

## 3DS / Redirect Note

`stripe.confirmPayment()` handles 3DS transparently. If the card requires authentication:

1. Stripe redirects the user to the bank's 3DS page (or shows an embedded modal)
2. After authentication, Stripe redirects back to `MERCHANT_RETURN_URL`
3. The storefront must call `POST /confirmPayments/:id` again after the redirect
4. The backend validates the now-succeeded PI and updates CT

---

## Error Paths

| Error | Cause | CT State |
|---|---|---|
| Elements validation fails | Invalid card data | No PI created; CT unchanged |
| `/payments` returns error | CT or Stripe API failure | No PI created; CT unchanged |
| PI metadata update fails | Stripe API error after PI creation | PI created but `ct_payment_id` missing; webhook events skipped |
| `stripe.confirmPayment()` fails | Card declined, 3DS failed | PI created in Stripe; CT has PENDING AUTHORIZATION (orphaned) |
| `/confirmPayments/:id` validation fails | PI/CT mismatch | CT stays PENDING; PI succeeded in Stripe (orphaned) |
