# Failure Modes — ct-connect-stripe-checkout

Operational failure scenarios for this connector are shared identically with `ct-connect-stripe-composable` — same code pattern (Payment Intent operations, webhook processing, webhook endpoint update at post-deploy, Stripe/CT unavailability, webhook signature verification), same blast radius, just different line numbers. They live in `../../context/failure-modes.md` rather than being duplicated here.

`checkout` has no subscription/product-type post-deploy step (unlike `composable`, see its own `context/failure-modes.md`), and no connector-unique *external-service* failure path has been found. The two scenarios below are specific to this connector and are not in the shared file.

---

## Bank transfer — abandoned wire leaves a `Pending` authorization nothing resolves

**Trigger:** A shopper reaches the bank transfer instruction sheet, the connector books an `AUTHORIZATION:PENDING`, and the wire is never sent.
**Current behavior on failure:** The pending authorization is durable. No terminal Stripe event arrives — the PaymentIntent is alive and waiting, so there is nothing to cancel. `Order.paymentState` stays `Pending` indefinitely, and the cart is **not** frozen for the funding window (`connect-payments-sdk` exposes no freeze capability; composable hand-rolls one against the platform SDK, checkout does not). There is no automated reconciliation and none is planned — the divergence is surfaced, never auto-corrected.
**Blast radius:** One order per abandonment, cumulative, since nothing ages them out. On a bank transfer rail this is ordinary abandonment rather than an edge case, so operators should expect a standing population of stale `Pending` authorizations and reconcile them out of band.
**File:** `processor/src/routes/stripe-payment.route.ts` (the `requires_action` branch); `processor/src/services/stripe-payment.service.ts` (`ASYNC_PENDING_EVENTS`)
**Recommendation:** None taken deliberately — building reconciliation is a separate decision that has not been made. Recorded as an accepted characteristic in `decisions/adr-007-async-settlement-processing.md` (Risks). See also `business-rules/order-payment-state.md`.

---

## Bank transfer — unrelated configuration silently suppresses the rail

**Trigger:** A merchant sets `euBankTransferCountry` for a market and deploys, while `setup_future_usage` (directly or via `STRIPE_SAVED_PAYMENT_METHODS_CONFIG`) or `capture_method: manual` is in effect for the same carts.
**Current behavior on failure:** Stripe removes `customer_balance` from `payment_method_types` whenever the payment method cannot be saved, and nulls the options — with **no error and no warning**. The tab never renders. The connector detects the known suppressing combinations at PaymentIntent creation and logs a warning (`resolveRailSuppression`), but it cannot make the tab appear, and forcing the rail is deliberately not done: composable tried it and removed it, because silently rewriting the merchant's capture policy surprises more than the tab's absence.
**Blast radius:** Market-wide — every qualifying cart in that market loses the rail. The failure is invisible in the direction an operator tests first: `setup_future_usage` is only bound when a customer is attached, and a bound customer is exactly what `customer_balance` requires, so it fails precisely on the carts that qualify.
**File:** `processor/src/mappers/bank-transfer-mapper.ts` (`resolveRailSuppression`, and the suppression table in its docblock); `processor/src/services/stripe-payment.service.ts` (the warning call site)
**Recommendation:** Surface the warning where a merchant will see it rather than only in processor logs. See `business-rules/payment-behavior-rules.md` for why the field is a treasury boundary rather than a fund-diversion one.

---

If another connector-unique scenario is found later, add it here rather than in the shared file.
