# Recurring Off-Session Charges

What `POST /operations/transactions` guarantees when commercetools asks for a recurring installment to
be charged against a saved method.

The route is OAuth2-authenticated and requires `manage_project` or `manage_checkout_transactions`
(`processor/src/routes/operation.route.ts:117-125`); it answers 201 with the transaction result.

## Rule 1: The installment id is a UUID and the sole idempotency anchor

**What:** `checkoutTransactionItemId` must be present and a UUID, or the request fails. Nothing else —
in particular not `futureOrderNumber` — is used as an anchor.
**Why:** it is the only idempotency anchor (Rules 5 and 6).
**Invariant:** `handleTransaction` throws `ErrorInvalidOperation` before any lookup when the id fails the
UUID test.
**Implementation:** `processor/src/services/stripe-payment.service.ts:3061-3067`

---

## Rule 2: The cart must be bound to a customer

**What:** a recurring charge on a cart without `customerId` is refused.
**Why:** the saved method is looked up per customer.
**Invariant:** `handleTransaction` throws when `ctCart.customerId` is falsy.
**Implementation:** `processor/src/services/stripe-payment.service.ts:3070-3073`

---

## Rule 3: A requested amount must match the cart's currency and not exceed it

**What:** if the draft carries an amount, its currency must equal the cart's and its value must not
exceed the cart amount.
**Why:** the caller may not charge more than commercetools says is owed.
**Invariant:** `resolveRecurringChargeAmount` throws for a currency mismatch or a larger amount.
**Implementation:** `processor/src/services/stripe-payment.service.ts:3106-3113`

---

## Rule 4: The amount charged is always the cart amount

**What:** the charged amount is the cart's payment amount, a positive integer, whatever amount the draft
requested.
**Why:** commercetools is the source of truth (`processor/src/services/stripe-payment.service.ts:3097-3100`).
**Invariant:** `amountPlanned` is built only from `cartAmount` and is rejected unless a positive integer.
**Implementation:** `processor/src/services/stripe-payment.service.ts:3114-3118`

---

## Rule 5: The Stripe idempotency key is the installment, never caller-supplied

**What:** the off-session PaymentIntent is created with the key `charge-{checkoutTransactionItemId}`;
`draft.idempotencyKey` is ignored.
**Why:** a retried installment returns the same PaymentIntent instead of charging again, so the caller
must not be able to vary the key (`processor/src/services/stripe-payment.service.ts:3286-3290`).
**Invariant:** the only `paymentIntents.create` on the recurring path uses that key.
**Implementation:** `processor/src/services/stripe-payment.service.ts:3306`, `:3317`

---

## Rule 6: An installment already resolved is returned, not charged; a stuck one is retried

**What:** if a Payment keyed by the installment id (`Payment.key`) already has an `Authorization` or
`Charge` in `Success`, `Failure` or `Pending`, its result is returned without calling Stripe. A payment
whose only transaction is `Authorization/Initial` (a prior attempt that died before Stripe) is **not**
resolved: it is reused and driven through the charge (re-attached to the cart if needed), never
re-created. A concurrent duplicate create resolves to the winner — its outcome if resolved, `Pending`
if it is still charging.
**Why:** commercetools' unique `Payment.key` is the cross-window dedupe; Stripe's key covers only 24 hours.
The native `checkoutTransactionItemId` field is not queryable as a `where` predicate on the deployed API,
which is why `key` carries the same value (`processor/src/services/stripe-payment.service.ts:3124-3130`).
**Invariant:** `chargeRecurringPaymentOffSession` is not reached when `hasResolvedRecurringOutcome(existing)`
is true.
**Implementation:** `processor/src/services/stripe-payment.service.ts:3146-3157` (dedupe), `:3456-3463`
(`hasResolvedRecurringOutcome`), `:3192-3209` (stuck-payment reuse), `:3237-3247` and `:3267-3281`
(duplicate-key winner), `:3477-3483` (`findPaymentByKey`, fails closed on a query error).

---

## Rule 7: The installment payment must belong to the cart's customer

**What:** an existing Payment found by key whose `customer.id` differs from the cart's customer is refused
— on the dedupe read, on stuck-payment reuse, and on the duplicate-key winner.
**Why:** the key is caller-supplied, so it alone does not prove ownership.
**Invariant:** `assertRecurringPaymentOwnership` throws on a customer mismatch.
**Implementation:** `processor/src/services/stripe-payment.service.ts:3148-3150`, `:3275`, `:3522-3526`

---

## Rule 8: The saved method must belong to the resolved Stripe customer

**What:** the saved method id is required from the request (`paymentMethod.id` or the flat
`paymentMethodId` alias, no "first saved method" fallback); its token is read from commercetools for the
cart's customer, and Stripe's `payment_method.customer` must equal that customer's Stripe id.
**Why:** a caller-supplied `pm_…` or customer id is never forwarded to Stripe
(`processor/src/services/stripe-payment.service.ts:3528-3538`).
**Invariant:** the charge is not attempted when `stripePaymentMethod.customer !== stripeCustomerId`.
**Implementation:** `processor/src/services/stripe-payment.service.ts:3539-3584` (required id `:3550-3556`,
CT lookup `:3557-3566`, ownership `:3577-3581`)

---

## Rule 9: The charge is confirmed immediately, captured automatically, without redirects

**What:** the off-session PaymentIntent uses `off_session: true`, `confirm: true`,
`capture_method: 'automatic'` and `automatic_payment_methods.allow_redirects: 'never'`, and stamps
`ct_payment_id`, `cart_id`, `ct_project_key` and `installment_id` in metadata at creation.
**Why:** no shopper is present to authenticate or redirect; the stamp lets the immediately-fired
`succeeded` webhook reconcile (`processor/src/services/stripe-payment.service.ts:3586-3593`). It is a
separate builder from the browser checkout's on purpose.
**Invariant:** `buildOffSessionPaymentIntentCreateParams` returns those four values.
**Implementation:** `processor/src/services/stripe-payment.service.ts:3594-3618`

---

## Rule 10: A card decline books an `Authorization/Failure` and returns a `Failed` result

**What:** a card error (including `authentication_required`) books `Authorization/Failure` if absent and
returns 201 with `state: 'Failed'` and code `PaymentRejected`. A returned non-terminal status
(`requires_action`, `requires_payment_method`) is treated the same way. Non-card errors are surfaced, not
masked.
**Why:** a decline is an outcome commercetools must record, not a contract violation; the dedup is
because a `payment_intent.payment_failed` webhook may write the same transaction.
**Invariant:** at most one `Authorization/Failure` exists afterwards.
**Implementation:** `processor/src/services/stripe-payment.service.ts:3355-3381` (thrown decline),
`:3318-3331` (returned non-terminal status), `:3390-3415` (`bookAuthorizationFailureIfAbsent`),
`:3642-3650` (`isStripeCardError`)
