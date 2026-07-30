# Business Rule: Payment Lifecycle

## Overview

A payment in this connector always involves two parallel objects: a **Stripe PaymentIntent** and a **CT Payment**. They must stay in sync. CT is the source of truth for transaction state; Stripe is the source of truth for money movement.

---

## Rule 1: PaymentIntent and CT Payment are created together atomically

**What:** `GET /payments` creates both a Stripe PaymentIntent and a CT Payment in the same request, then associates the CT Payment to the cart.

**Why:** The cart needs a CT Payment reference before the user can confirm. If only Stripe PI is created, CT has no record of the pending payment.

**Invariant:** A Stripe PaymentIntent must always have a corresponding CT Payment. Never create one without the other.

**Implementation:** `stripe-payment.service.ts` → `createPaymentIntentStripe()`

**What breaks if violated:** CT has no transaction to update when the webhook arrives. The payment is lost from CT's perspective even if Stripe charged the customer.

---

## Rule 2: PaymentIntent must pass 4-point validation before CT is updated to AUTHORIZED

**What:** After Stripe confirms a payment, the backend re-retrieves the PI from Stripe and validates:
1. PI exists and was retrieved successfully
2. PI status is `succeeded`, `requires_capture`, or `processing` (async settlement → resolves to a PENDING outcome, not AUTHORIZED — see Rule 8)
3. `PI.metadata.ct_payment_id` matches the CT payment ID in the request
4. `PI.amount` and `PI.currency` match the CT payment values

**Why:** Prevents replay attacks and accidental cross-payment contamination. A client could pass any PI ID to `/confirmPayments/:id`.

**Invariant:** All 4 checks must pass. Failure on any one must reject the confirmation and leave CT in the previous state.

**Implementation:** `stripe-payment.service.ts` → `updatePaymentIntentStripeSuccessful()`

**What breaks if violated:** A malicious client could confirm a different customer's payment against this cart, or confirm a failed/canceled PI as successful.

---

## Rule 3: Capture method is set at PI creation and cannot change

**What:** `STRIPE_CAPTURE_METHOD` (`automatic`, `automatic_async`, `manual`) is passed to Stripe at PI creation. Manual capture requires an explicit `capturePayment` call later.

**Why:** Stripe does not allow changing capture method after PI creation. The decision is permanent for that transaction.

**Invariant:** Never attempt to capture a PI created with `automatic` capture — it was already charged at confirmation.

**Implementation:** `config.ts` → `STRIPE_CAPTURE_METHOD`, `stripe-payment.service.ts` → `buildPaymentIntentCreateParams()`

**What breaks if violated:** Capturing an `automatic` PI returns a Stripe error. The CT Payment ends up in an inconsistent state if the error is not handled correctly.

---

## Rule 4: CT Payment version must be tracked for optimistic locking

**What:** CT uses optimistic locking on Payment updates. The version number must be current when sending update actions.

**Why:** Concurrent webhook events or multiple captures could collide on the same CT Payment. Stale version = rejected update.

**Invariant:** Always retrieve the latest CT Payment version before any update. Never cache the version across requests.

**Implementation:** `ctPaymentService.updatePayment()` and `ctPaymentService.getPayment()` are used together by call sites in `processor/src/services/stripe-payment.service.ts` (e.g. `updatePaymentIntentStripeSuccessful`, `processStripeEvent`, `processStripeEventRefunded`, `processStripeEventMultipleCaptured`).

**Note — limitation:** The Connect Payments SDK does **not** automatically retry on `409 ConcurrentModification` (see `context/reference/ct-connect-payments-sdk.md`). On a version conflict the call throws and the connector currently logs the error and continues; there is no retry loop. If concurrent webhooks for the same CT payment become a real concern, retry-with-fresh-version logic needs to be added at each `updatePayment` call site.

**What breaks if violated:** CT returns a `409 ConcurrentModification` error. The transaction update is lost and CT state diverges from Stripe.

---

## Rule 5: Express Checkout skips shipping on PaymentIntent

**What:** When `x-express-checkout: true` header is present on `GET /payments`, the PI is created without shipping parameters. Shipping is handled by the Express Checkout Element callbacks.

**Why:** Express Checkout (Apple Pay, Google Pay) collects shipping natively in the wallet UI. Adding it to the PI would conflict with the wallet's own address handling.

**Invariant:** Never pass shipping data to the PI when Express Checkout is active. The wallet owns the shipping address.

**Implementation:** `stripe-payment.service.ts` → `buildPaymentIntentCreateParams()`, checks `expressCheckout` flag.

**What breaks if violated:** Stripe returns a validation error or the wallet shows conflicting shipping information.

---

## Rule 7: Express Checkout with a known customer binds `customer` and `setup_future_usage` on the PI

**What:** When Express Checkout uses the `_Setup` path (CT session and cart available at button render time), the enabler sends `x-express-customer-session: true` on `GET /payments`. The processor uses this signal to include `customer` and `setup_future_usage` on the PI — the same as the standard embedded checkout path.

When Express Checkout uses the `_SetupExpress` path (deferred, no session at render time), this header is never sent and the PI remains one-shot with no customer binding.

**Why:** The `_Setup` path creates Stripe Elements with `customerOptions` and `setupFutureUsage`. The PI must match — Stripe rejects `confirmPayment` with a `setup_future_usage` mismatch error if they differ. Conditioning on `x-express-customer-session` (set only by the enabler when Elements was initialized with customer data) is the only reliable way to distinguish the two Express paths from the processor side.

**Invariant:** `expressWithCustomer = expressCheckout && Boolean(stripeCustomerId) && expressCustomerSession`. All three conditions must be true. The header is the necessary gate — `stripeCustomerId` alone is insufficient because a CT customer can have a Stripe ID from a previous checkout while still using `_SetupExpress`.

**Implementation:**

- Enabler: `dropin-express.ts` → `getHeadersConfig()` — sets `x-express-customer-session: true` when `this.baseOptions.stripeCustomerId` is set
- Route: `stripe-payment.route.ts` → reads `x-express-customer-session` header, passes `isExpressCustomerSession` to service
- Service: `stripe-payment.service.ts` → `createPaymentIntentStripe(expressCheckout, expressCustomerSession)` and `buildPaymentIntentCreateParams()` (condition `!expressCheckout || expressWithCustomer`)
- CORS: `server.ts` → `x-express-customer-session` in `allowedHeaders`

**Closure criterion:** `grep -n 'expressWithCustomer' processor/src/services/stripe-payment.service.ts` — must appear in both the flag assignment and the spread condition. `grep -n 'x-express-customer-session' enabler/src/express/dropin-express.ts` — must appear in `getHeadersConfig()`.

**What breaks if violated:** Elements carries `setup_future_usage` but the PI does not → Stripe rejects `confirmPayment`. Or PI carries `setup_future_usage` but Elements does not → same rejection, opposite direction.

---

## Rule 6: Amounts always in cents (integer), never decimals

**What:** All amounts passed to Stripe and stored in CT are integers representing the smallest currency unit (cents for USD/EUR).

**Why:** Floating-point math on currency values causes rounding errors. Stripe's API requires integers.

**Invariant:** Never pass a decimal amount to Stripe. Never divide an amount and pass the result without rounding to integer.

**Implementation:** `ctCartService.getPaymentAmount()` returns centAmount; passed directly to Stripe.

**What breaks if violated:** Stripe rejects the request with a validation error, or — worse — accepts a rounded value that differs from the cart total, causing a mismatch between what was charged and what CT records.

---

## Rule 8: Async settlement (`processing`) is modeled as `Authorization/Pending`; the order is created only on `succeeded`

> Draft — added for crypto/stablecoin async settlement (ADR-007). `[HUMAN REVIEW]` on the reconciliation stance below.

**What:** Asynchronous / redirect payment methods (crypto/stablecoin today; ACH / bank transfers next) confirm into a Stripe `processing` status before settling. The connector models this in-flight state as a CT `Authorization` transaction in the `Pending` state (amount from `data.amount`), and transitions it to `Success` on `payment_intent.succeeded`. The CT **order is created only on `succeeded`**, never during `processing`.

**Why:** Settlement lands out of band (minutes on mainnet). The buyer must not be fulfilled before funds settle, but the in-flight payment must still be visible in CT. `Authorization/Pending` is the natural pre-settlement state and transitions cleanly to `Success` (avoids duplicating the `Charge` written on `succeeded`).

**Invariant:** While the PI is `processing`, the CT Payment carries at most an `Authorization/Pending` (never `Charge/Success`, never an order). The order and `Charge/Success` appear only after `payment_intent.succeeded`.

**Extends Rule 2:** the confirm gate now accepts `processing` in addition to `succeeded`/`requires_capture` — but a `processing` PI resolves to a `PENDING` outcome (HTTP 202, writes `Authorization/Pending` only), NOT `AUTHORIZED`. The other three validation points (PI retrieved, `metadata.ct_payment_id` match, amount/currency match) are unchanged. (Rule 2 point 2 has been updated to list `processing` as an accepted status resolving to `PENDING`.)

**Implementation:** `stripe-payment.service.ts` → `updatePaymentIntentStripeSuccessful()` (returns `PaymentModificationStatus.PENDING` for `processing`) and `processStripeEvent()` (webhook path: `Authorization/Pending`, then Pending→Success on `succeeded`); `stripeEventConverter.ts` → `case PAYMENT_INTENT__PROCESSING`.

**Closure criterion:** `grep -n 'PaymentModificationStatus.PENDING' processor/src/services/stripe-payment.service.ts` — appears in the gate. `grep -n 'PAYMENT_INTENT__PROCESSING' processor/src/services/converters/stripeEventConverter.ts` — the converter case exists.

**What breaks if violated:** If the order is created on `processing`, a payment that later fails/cancels leaves a fulfilled, unpaid order. If `processing` is not modeled at all, the confirm gate rejects it and the shopper sees a false checkout error on a payment that is settling normally.
