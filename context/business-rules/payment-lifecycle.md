# Payment Lifecycle

What `GET /payments` guarantees about the Stripe PaymentIntent and the commercetools Payment it creates
for a checkout cart, and the checks `POST /confirmPayments/:id` applies before it records an
authorization. A payment in this connector always involves two parallel objects: a **Stripe
PaymentIntent** and a **CT Payment**. They must stay in sync. CT is the source of truth for transaction
state; Stripe is the source of truth for money movement.

---

## Rule 1: PaymentIntent and CT Payment are created together

**What:** On a cart with no reusable payment (Rule 13), `GET /payments` creates a Stripe PaymentIntent and
a CT Payment and associates the CT Payment to the cart. The Payment is created with exactly one
transaction — `Authorization/Initial` for the planned amount, whose `interactionId` is the PaymentIntent
id — so later webhooks and the confirm gate have a transaction to locate and update. The PaymentIntent
create, the Payment create and the cart attach are three separate calls.

**Why:** The cart needs a CT Payment reference before the user can confirm.

**Invariant:** Every PaymentIntent handed back to the client has a corresponding CT Payment attached to
the cart, whose `Authorization/Initial` carries that PaymentIntent's id.

**Implementation:** `processor/src/services/stripe-payment.service.ts:750-962` → `createPaymentIntentStripe()`;
Payment draft `:899-920` (`Authorization/Initial`, `interactionId: paymentIntent.id`, `:912-919`); attach
`:936-942`.

---

## Rule 2: The confirm gate validates the PaymentIntent before CT is updated — six checks

**What:** After Stripe confirms a payment, the backend re-retrieves the PI from Stripe and validates, in
this order:

1. **The session cart references the payment being confirmed** — before any Stripe call
2. PI exists and was retrieved successfully
3. PI status is `succeeded`, `requires_capture`, or `processing` (async settlement → resolves to a PENDING outcome, not AUTHORIZED — see Rule 8), or `requires_action` **only** when `next_action` carries bank-transfer instructions (same predicate as the webhook route)
4. `PI.metadata.ct_payment_id` matches the CT payment ID in the request
5. **`PI.metadata.cart_id` matches the session cart** — the PI's origin cart, stamped at creation
6. `PI.amount` and `PI.currency` match the CT payment values (`amountPlanned`; currency case-insensitive)

**Invariant:** All six checks must pass. Failure on any one throws before any CT write and leaves CT in
the previous state — `updatePaymentIntentStripeSuccessful` reaches no `updatePayment` until all six have
passed.

**Implementation:** `processor/src/services/stripe-payment.service.ts:1547-1670` →
`updatePaymentIntentStripeSuccessful()`: (1) `:1572` → `assertCartReferencesPayment()` `:1686-1695`;
(2) `:1574-1585`; (3) `:1596-1608`; (4) and (5) `:1611` → `assertPaymentIntentIdentity()` `:1712-1738`
(`ct_payment_id` `:1718-1726`, `cart_id` `:1728-1737`); (6) `:1613-1630`. Origin cart stamp at creation
`:1476`. The first CT write is `:1654` (async) or `:1658` (sync).

---

## Rule 3: Capture method is set at PI creation and never changed afterwards

**What:** `STRIPE_CAPTURE_METHOD` (`automatic`, `automatic_async`, `manual`) — or a market rule's
`captureMethod` that overrides it — is passed to Stripe at PI creation. Manual capture requires an
explicit `capturePayment` call later.

**Why:** the capture method is decided once, at PI creation, and is permanent for that transaction: an
existing PaymentIntent is never updated to a different capture method — when a request resolves a
different one, a new PaymentIntent is created instead. The reuse check refuses an open PaymentIntent whose
`capture_method` differs from the one requested (`processor/src/services/stripe-payment.service.ts:1347`).
The permanence is this connector's rule.

**Invariant:** Never attempt to capture a PI created with `automatic` capture — it was already charged at confirmation.

**Implementation:** `processor/src/config/config.ts:255` → `STRIPE_CAPTURE_METHOD` (default `automatic`);
resolved per cart as `behaviorRule?.captureMethod ?? config.stripeCaptureMethod`
(`processor/src/services/stripe-payment.service.ts:778`); written by `buildPaymentIntentCreateParams()`
(`:1474`). The recurring path's fixed `automatic` is separate (`recurring-charges.md` Rule 9).

---

## Rule 4: CT Payment version must be tracked for optimistic locking

**What:** CT uses optimistic locking on Payment updates. The version number must be current when sending update actions.

**Why:** Concurrent webhook events or multiple captures could collide on the same CT Payment. Stale version = rejected update.

**Invariant:** Always retrieve the latest CT Payment version before any update. Never cache the version across requests.

**Implementation:** `ctPaymentService.updatePayment()` and `ctPaymentService.getPayment()` are used together by call sites in `processor/src/services/stripe-payment.service.ts` (e.g. `updatePaymentIntentStripeSuccessful`, `processStripeEvent`, `processStripeEventRefunded`, `processStripeEventMultipleCaptured`). The only version-aware writes in the connector are the order writes (`:2531`, `:2557`) and the cart attach (`:936-942`); the order write retries once on a 409 (`order-payment-state.md` Rule 5).

---

## Rule 5: Express Checkout skips shipping on PaymentIntent

**What:** When `x-express-checkout: true` header is present on `GET /payments`, the PI is created without shipping parameters. Shipping is handled by the Express Checkout Element callbacks.

**Why:** Express Checkout (Apple Pay, Google Pay) collects shipping natively in the wallet UI. Adding it to the PI would conflict with the wallet's own address handling.

**Invariant:** Never pass shipping data to the PI when Express Checkout is active. The wallet owns the shipping address. `shipping` is set only when `expressCheckout` is false and an address exists.

**Implementation:** `processor/src/services/stripe-payment.service.ts:1480` → `buildPaymentIntentCreateParams()`, checks `expressCheckout` flag; the header is read at `processor/src/routes/stripe-payment.route.ts:85-86` (`'true'` or `'1'`). The reuse match also requires shipping presence to agree (`stripe-payment.service.ts:832`, `:1350`).

---

## Rule 6: Amounts always in cents (integer), never decimals

**What:** All amounts passed to Stripe and stored in CT are integers representing the smallest currency unit (cents for USD/EUR).

**Why:** Floating-point math on currency values causes rounding errors. Stripe's API requires integers.

**Invariant:** Never pass a decimal amount to Stripe. Never divide an amount and pass the result without rounding to integer.

**Implementation:** `ctCartService.getPaymentAmount()` returns centAmount; passed directly to Stripe (`processor/src/services/stripe-payment.service.ts:777`, `:1469`). Webhook amounts are taken verbatim from Stripe's integer fields (`stripeEventConverter.ts:388-414`).

---

## Rule 7: Express Checkout with a known customer binds `customer` and `setup_future_usage` on the PI

**What:** When Express Checkout uses the `_Setup` path (CT session and cart available at button render time), the enabler sends `x-express-customer-session: true` on `GET /payments`. The processor uses this signal to include `customer` and `setup_future_usage` on the PI — the same as the standard embedded checkout path.

When Express Checkout uses the `_SetupExpress` path (deferred, no session at render time), this header is never sent and the PI remains one-shot with no customer binding.

**Why:** The `_Setup` path creates Stripe Elements with `customerOptions` and `setupFutureUsage`. The PI must match — Stripe rejects `confirmPayment` with a `setup_future_usage` mismatch error if they differ. Conditioning on `x-express-customer-session` (set only by the enabler when Elements was initialized with customer data) is the only reliable way to distinguish the two Express paths from the processor side.

**Invariant:** `expressWithCustomer = expressCheckout && Boolean(stripeCustomerId) && expressCustomerSession`. All three conditions must be true. The header is the necessary gate — `stripeCustomerId` alone is insufficient because a CT customer can have a Stripe ID from a previous checkout while still using `_SetupExpress`. And `setup_future_usage` never appears in the params without `customer`.

**Implementation:**

- Enabler: `enabler/src/express/dropin-express.ts:590-602` → `getHeadersConfig()` — sets `x-express-customer-session: true` when `this.baseOptions.stripeCustomerId` is set (`:598-600`)
- Route: `processor/src/routes/stripe-payment.route.ts:87-88` → reads `x-express-customer-session` header, passes `isExpressCustomerSession` to service
- Service: `processor/src/services/stripe-payment.service.ts:750-753` → `createPaymentIntentStripe(expressCheckout, expressCustomerSession)`, `:1372-1378` → `resolveExpressWithCustomer()`, and `buildPaymentIntentCreateParams()` (`:1464-1468`, condition `!expressCheckout || expressWithCustomer`, with `setup_future_usage` nested inside the customer spread)
- CORS: `processor/src/server/server.ts:41` → `x-express-customer-session` in `allowedHeaders`

---

## Rule 8: Async settlement is modeled as `Authorization/Pending`; the connector never creates the order

**What:** Asynchronous / redirect payment methods (crypto/stablecoin; ACH `us_bank_account`; EU bank
transfers) confirm into a Stripe `processing` status before settling. The connector models this in-flight
state as a CT `Authorization` transaction in the `Pending` state (amount from `data.amount`), and
transitions it to `Success` on `payment_intent.succeeded`. **The connector never creates the order** —
commercetools Checkout owns order creation, and the order may already exist while the PI is `processing`.

**Why:** Settlement lands out of band (minutes on mainnet). The buyer must not be fulfilled before funds settle, but the in-flight payment must still be visible in CT. `Authorization/Pending` is the natural pre-settlement state and transitions cleanly to `Success` (avoids duplicating the `Charge` written on `succeeded`).

**Invariant:** While the PI is `processing`, the connector writes at most an `Authorization/Pending`, never
a `Charge/Success`, and creates no order. commercetools Checkout may already have created the order (it
owns creation).

**Extends Rule 2:** the confirm gate accepts `processing` in addition to `succeeded`/`requires_capture` —
but a `processing` PI resolves to a `PENDING` outcome (HTTP 202, writes `Authorization/Pending` only), NOT
`AUTHORIZED`. The same holds for a `requires_action` PI carrying bank-transfer instructions. Every other
allowed status books `Authorization/Success` at `amountPlanned` and answers 200 `approved`. The remaining
validation points are unchanged.

**Implementation:** `processor/src/services/stripe-payment.service.ts:1547-1670` →
`updatePaymentIntentStripeSuccessful()` (async branch `:1653-1656` returns `PaymentModificationStatus.PENDING`; sync branch `:1658-1669` returns `APPROVED`), deduped Pending write `:1755-1780`; status → HTTP mapping `processor/src/routes/stripe-payment.route.ts:121-123`; `processStripeEvent()` (webhook path: `Authorization/Pending`, then Pending→Success on `succeeded`, `:2085-2087`, `:2198-2228`); `stripeEventConverter.ts:289-301` → `case PAYMENT_INTENT__PROCESSING`.

---

## Rule 9: The amount comes from the commercetools cart, never from the client

**What:** The PaymentIntent amount and currency are the cart's payment amount as computed by
commercetools; no client-supplied amount is accepted.

**Why:** commercetools is the source of truth for cart state.

**Invariant:** `createParams.amount` is `amountPlanned.centAmount` from `ctCartService.getPaymentAmount`.

**Implementation:** `processor/src/services/stripe-payment.service.ts:777` (read), `:1469-1470` (written);
the route passes no body to `createPaymentIntentStripe` (`processor/src/routes/stripe-payment.route.ts:74-91`).

---

## Rule 10: Every Payment the processor creates carries the configured payment interface

**What:** `paymentMethodInfo.paymentInterface` is set from `PAYMENT_INTERFACE` (default
`checkout-stripe`) on checkout payments; recurring payments use the request's value if given.

**Why:** it is how this connector's payments are told apart from other connectors' on the same
project; the order-subscriber (`order-payment-state.md` Rule 7) and the reuse check (Rule 13) both filter
on it.

**Invariant:** both `createPayment` calls set `paymentMethodInfo.paymentInterface`.

**Implementation:** `processor/src/services/stripe-payment.service.ts:906-910` (checkout), `:3216`,
`:3223-3227` (recurring); `processor/src/config/config.ts:267`.

---

## Rule 11: Every PaymentIntent handed back is linked to its Payment through `metadata.ct_payment_id`

**What:** after the Payment exists, the PaymentIntent's metadata is updated with `ct_payment_id`;
creation metadata already carries `cart_id`, `ct_project_key` and, for a known customer,
`ct_customer_id`. On reuse, a PaymentIntent whose stamp is missing or stale is re-stamped before it is
returned; if that fails, the candidate is skipped and a fresh PaymentIntent is created.

**Why:** webhooks and the confirm gate find the Payment only through this key (Rule 2 check 4;
`webhook-handling.md` Rule 8).

**Invariant:** every PaymentIntent returned by `GET /payments` carries `metadata.ct_payment_id` equal to
the returned `paymentReference`.

**Implementation:** `processor/src/services/stripe-payment.service.ts:951` → `updatePaymentIntentMetadata()`
(`:1390-1405`, random idempotency key); creation metadata `:1475-1479`; reuse self-heal `:1310-1329`
(`finalizeReuseCandidate`) and `:1136-1140` (winner path).

---

## Rule 12: A tax calculation is attached only when there is exactly one

**What:** `hooks.inputs.tax.calculation` is set only when the cart's tax-calculation references custom
field has exactly one entry; zero or several are treated as "no tax data", never guessed.

**Why:** the PaymentIntent accepts one calculation; the code does not choose between several.

**Invariant:** `hooks` is present in the create params iff the reference count is 1.

**Implementation:** `processor/src/services/stripe-payment.service.ts:1026-1041` → `resolveTaxCalculation()`;
`:1523-1531` (written).

---

## Rule 13: A repeated `GET /payments` reuses the cart's active payment, or refuses — never a second charge

**What:** before creating anything, `createPaymentIntentStripe` walks the payments attached to the
session cart. A candidate is **reused** (its PaymentIntent's client secret is returned, nothing created)
only when it is this connector's payment, still has an `Authorization/Initial`, matches the current
planned amount and currency, its PaymentIntent is open (`requires_payment_method`,
`requires_confirmation`, `requires_action`), and that PaymentIntent's `capture_method`, **applied**
`setup_future_usage`, customer binding and shipping presence equal what this request would create. If
instead an attached PaymentIntent is already `succeeded`, `requires_capture` or `processing` while its CT
`Authorization` is still `Initial` (the confirm or webhook write has not landed yet), the request is
**refused** with an error. Anything else falls through to a fresh create.

**Why:** commercetools accepts multiple payments per cart by design. The configuration match prevents
handing an express-without-customer PaymentIntent to a drop-in call that needs a customer and shipping.

**Invariant:** `createPaymentIntentStripe` never creates a second PaymentIntent for a cart that already
carries a reusable or in-progress payment of this connector.

**Implementation:** `processor/src/services/stripe-payment.service.ts:819-844` (requested configuration
and call), `:1048-1079` → `buildReuseResponse()` (refuse `:1054-1063`), `:1203-1225` →
`findReusablePayment()`, `:1233-1300` → `evaluateReuseCandidate()` (settled statuses `:1281-1284`, open
statuses `:1286-1293`), `:1337-1352` → `reusePiConfigMatches()`. Enabler per-instance in-flight/once guard
`enabler/src/express/dropin-express.ts:403-415`.

---

## Rule 14: The unique Payment key is the concurrent-create mutex; a loser reuses the winner only if the cart ends up referencing it

**What:** the checkout Payment is created with `key = pi-create-{cartId}-{cart.version}`. Two concurrent
`GET /payments` that both passed Rule 13 contend on that key; commercetools lets one `createPayment` win and
the loser gets `DuplicateField`. The loser then returns the **winner's** PaymentIntent — but only if that
PaymentIntent is open, has a client secret, matches the amount and passes the same configuration match as
Rule 13, **and** the cart references the winner by the end (attaching it if needed, re-reading the cart if
the attach fails). Otherwise the original error is rethrown and no PaymentIntent is handed out.

**Why:** commercetools' `addPayment` retries a 409 with a fresh cart version, so it is not the mutex; the
database-level unique Payment key is.

**Invariant:** a cart never ends up with two Payments for one cart version, and the loser path never
returns a PaymentIntent whose Payment the cart does not reference.

**Implementation:** `processor/src/services/stripe-payment.service.ts:892-934` (key `:897`, catch
`:921-934`), `:1086-1153` → `reuseWinnerOnDuplicateKey()`, `:1162-1185` → `ensureCartReferencesWinner()`,
`:3491-3513` → `isCtDuplicateKeyError()` (matches the raw and the SDK-wrapped error shapes).

---

## Rule 15: Any confirmation failure answers 400 `rejected` with a fixed message

**What:** every error thrown during confirm becomes `{ outcome: 'rejected', error: 'Payment confirmation
failed' }` with status 400; the log carries scalars only.

**Why:** the enabler distinguishes success by status and outcome; detail stays in the server log.

**Invariant:** the route's `catch` sends 400 with a fixed body and logs no error object.

**Implementation:** `processor/src/routes/stripe-payment.route.ts:116-143` (`catch` `:124-142`).
