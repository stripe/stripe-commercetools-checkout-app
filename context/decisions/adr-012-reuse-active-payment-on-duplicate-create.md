# ADR-012: Reuse the cart's active Payment on a duplicate `GET /payments` instead of a stable idempotency key

**Status:** Accepted
**Date:** 2026-10-01

## Context

A duplicate express-checkout confirm (the wallet emitting `onPaymentSubmit` twice) made the enabler call
`GET /payments` → `createPaymentIntentStripe` more than once for the same cart. The method created a fresh
PaymentIntent + commercetools Payment and `addPayment`-ed it every time, so the cart ended up with two
Payments and two charged PaymentIntents — a real production double charge (SB3-231). commercetools accepts
multiple payments per cart by design, so nothing downstream rejects the second one; the guard must live in
the connector. `GET /payments` is the shared create path for every method (embedded drop-in + express), so
the fix had to be safe for all of them.

## Decision

`createPaymentIntentStripe` reuses an existing **active** Payment already attached to the session cart
(`findReusablePayment`) instead of creating a second one. A candidate is **reused** only when it is this
connector's payment (`paymentInterface`), has an `Authorization` still in `Initial` state, matches the
current planned amount + currency, whose Stripe PaymentIntent is still in an **open/confirmable** status, AND
whose `capture_method`, **effectively applied** `setup_future_usage`, **customer binding and shipping
presence** match what this request would create. If instead the attached PI is already **settled/in-progress**
(`succeeded`/`requires_capture`/`processing`) while the CT `Authorization` is still `Initial` (the
`/confirmPayments` or webhook write has not landed — the Pooch & Mutt window), the request is **rejected**
rather than minting a second PI. The PaymentIntent create keeps a **per-call `crypto.randomUUID()`**
idempotency key; the concurrent-create race is bounded by a **unique CT `Payment.key`**
(`pi-create-{cartId}-{cart.version}`) — CT's unique-key constraint is the mutex, the loser gets
`DuplicateField` and reuses the winner. The enabler adds an in-flight/once guard around
`handlePaymentConfirm` and signals failures to the wallet via `event.paymentFailed`.

## Alternatives Considered

| Alternative | Why discarded |
| --- | --- |
| Stable idempotency key `pi-create-{cartId}-{amount}-{currency}` on create | Stripe replays the **cached create response** for 24h; once the original PI is canceled/expired, the reuse check falls through and the stable key replays the *dead* PI, stranding the cart for up to 24h. It also does not stop the commercetools-side duplicate (`createPayment`/`addPayment` are separate calls). Net-negative vs `randomUUID`. |
| Enabler guard only | Per-instance; does not survive retries, multiple tabs, or a replayed request. Necessary as defense-in-depth but not sufficient. |
| Match reuse on amount+currency only | Would reuse a PI configured for a different flow — e.g. an express-without-customer PI (no `customer`, no `shipping`) handed back to a drop-in call that needs them bound, or a PI minted without a `setup_future_usage` mandate — or false-skip and re-open the double charge. Hence the config-aware match against the *applied* capture method, SFU, customer binding and shipping presence. |
| Rely on `addPayment` optimistic locking for the concurrent race | The connect-payments-sdk `addPayment` catches the 409 and retries with a fresh cart version (maxRetries 6), so the second attach succeeds — it is **not** a mutex. The unique `Payment.key` (DB-level constraint) is. |

## Consequences

**Positive:** one Payment + one PaymentIntent per cart even under duplicate confirms; self-recovering create key (no 24h stranding); safe for every method on the shared create path.
**Negative:** `findReusablePayment` adds a `getPayment` + `paymentIntents.retrieve` round-trip per attached payment on `GET /payments` (fine for the typical 0–1 payment cart).
**Risks:** a truly-concurrent double create still mints two Stripe PaymentIntents, but CT's unique-key constraint on the `Payment.key` (`pi-create-{cartId}-{cart.version}`) lets only one `createPayment` win — the loser gets `DuplicateField` and reuses the winner, so the cart never ends up with two Payments and only the winner's PI is confirmed (the loser's is an unconfirmed orphan; no double charge). The `addPayment` 409 is **not** the guard — the connect-payments-sdk retries it with a fresh cart version (so it would otherwise let the second attach through). Does not change the confirm-time cross-cart binding (`cartReferencesPayment`), which still runs independently.

**DuplicateField detection (2nd review).** The loser-reuses-winner path only works if the `DuplicateField` is recognized. `createPayment` goes through the connect-payments-sdk, which wraps the raw ts-client `BadRequest` in a `CommercetoolsAPIError` (`code`, `httpErrorStatus`, `fields` = the raw `body.errors`, `cause` = the raw error) — it has **no top-level `statusCode`/`body`**. `isCtDuplicateKeyError` therefore matches the wrapped shape (`fields`), the raw shape (`body.errors`), and the `cause`, so detection holds wherever the throw is caught. (The same helper backs the recurring KI-028 winner path, which this also corrects.)

**Failed-attach recovery (2nd review).** The key is `cart.id + cart.version`, so if `addPayment` fails after `createPayment` succeeds, the cart version does not move and a retry re-collides on the same key. `reuseWinnerOnDuplicateKey` therefore validates the winner's PI is open + amount-matching and **attaches the winner when the cart does not already reference it** (tolerating a concurrent attach), so the retry succeeds instead of minting an orphan PI every time.

**`ct_payment_id` self-heal (2nd review).** If the create path's `updatePaymentIntentMetadata` fails after `addPayment`, the cart carries a Payment whose open PI has no `ct_payment_id`; reusing it as-is would charge the shopper and then be rejected at confirm (`assertPaymentIntentIdentity`) and skipped by the webhook — money taken, no CT record. Both reuse paths (`evaluateReuseCandidate` and the winner path) re-stamp `ct_payment_id` before reuse, and **fail closed** (skip → fresh PI) if the stamp cannot be set, so an unstamped PI is never handed back.

**Winner must end attached + config match (3rd review).** The 2nd-review attach step tolerated a concurrent attach by **swallowing** any attach failure and returning the winner regardless. That was wrong on a genuine double failure: if `addPayment` fails again and the cart still does not reference the winner, the connector was handing back a payable PI for a payment the cart does not reference — the shopper could pay it and confirm would then reject it (`assertCartReferencesPayment`) after the charge already landed (charge-without-order). `reuseWinnerOnDuplicateKey` now delegates to `ensureCartReferencesWinner`: after a failed attach it **re-reads the cart** and continues only if the cart now references the winner (the legitimate concurrent-winner race); otherwise it **rethrows**, so the caller errors without handing out a PI — restoring the pre-#388 safe outcome. The winner path also now applies the same `reusePiConfigMatches` guard as `evaluateReuseCandidate` (capture method, applied `setup_future_usage`, customer binding, shipping presence), so a winner minted for a different flow (express ↔ drop-in on a failure retry) is rethrown instead of handed back. Reproduced live against the deployed connector by forcing a deterministic `addPayment` failure with an Ordered cart (a frozen cart does **not** block `addPayment`): pre-fix the 2nd `GET /payments` returned 200 with the winner while the cart's `paymentInfo` was empty; post-fix it rethrows (400, no PI).
