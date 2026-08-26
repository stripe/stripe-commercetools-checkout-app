# ADR-009: The Connector Reflects the Payment Outcome onto `Order.paymentState`

**Status:** Accepted — **Amended 2026-08-20: the amendment reverses the "asynchronous rails only" scope**
**Date:** 2026-08-18

> **Title changed 2026-08-20.** It read *"…for Asynchronous Rails Only"*. That qualifier was the part
> the amendment below reverses, and leaving it in the title would make the file's own name
> contradict its decision.

---

## Amendment — 2026-08-20: the connector records card payments too

**What changed:** the connector now writes `Paid` for a synchronous card. The original decision left
such orders unset on the reasoning that a live browser and a site callback made finalizing them the
site's/merchant's job.

**Why it changed — a measurement, not a preference.** Three real card runs (`56b9b31c`, `547df304`,
`e47dd1a0`) showed commercetools Checkout creating the order **333 ms, 701 ms and 877 ms *after***
`Charge/Success`. So the sequence the original decision assumed does not exist:

1. `payment_intent.succeeded` reaches the processor while **no order exists**.
2. A terminal target gets **one** lookup attempt with no retry, so the write is skipped.
3. The order is then created — already final, with nobody left to record it.
4. **No further event ever arrives.** Nothing corrects it.

"Left for the site to finalize" was therefore never a division of labour in practice; it was an
order nobody recorded. Two supporting observations: the sample site does not finalize it either, and
a merchant installing a *payments* connector reasonably expects payment state to be recorded. Adding
retry to terminal targets does **not** fix this — even with the order found, `connectorOwnsOrderPaymentState`
correctly declines a card (no `Authorization/Pending`), and the retry would hold the Stripe webhook
open ~11 s on **every** card payment, since webhooks here are processed synchronously with no early ack.

**Who writes it:** the `order-subscriber`, on `OrderCreated`. It is the only writer for which the
order provably exists, and it is already asynchronous, so no webhook is held open. Rules: see
`business-rules/order-payment-state.md` Rule 6.

**What is still deliberately not written:** a card authorized but **not captured**
(`STRIPE_CAPTURE_METHOD=manual`) resolves to nothing. `Paid` would be false; `Pending` misdescribes
it, because nothing is awaited from the shopper — the merchant simply has not captured. This is the
one case where deferring to the merchant is honest, since the merchant is the actor. `BalanceDue`
remains out of scope; adding it is a product decision.

**A correction to how this amendment was first scoped.** The initial assessment claimed this required
extracting the full transition lattice (`shouldTransitionOrderPaymentState`) into a shared package,
because the subscriber would begin writing a terminal state. That was wrong: the subscriber writes
**only onto an unset field** and never transitions, so there is no matrix to duplicate and none to
drift. Both race directions resolve without it — processor first, the subscriber finds the field
occupied and skips; subscriber first, Rule 5 sees `Paid → Paid` and no-ops. The work was
correspondingly smaller than first estimated.

**Requested by:** Luis. Recorded as a reversal rather than applied silently, because Rule 2's
ownership check exists specifically to implement the superseded decision and now expresses a
narrower policy than the connector as a whole.

**Consequence to watch:** for a card, `connectorOwnsOrderPaymentState` is now effectively vestigial —
it declines, and the subscriber has already written the state. It is retained because it still
governs `Failed` and the bank-transfer settlement path, but it is no longer the connector's single
answer to "do we own this order".

### Follow-up from the 2026-08-21 test round

**`Failed` is unreachable in checkout, and that is correct.** A declined authorization produces no
order at all — commercetools Checkout does not create one — so there is nothing to mark `Failed`.
Confirmed by Luis on 2026-08-21 as the desired behaviour, not a gap: the shopper reuses the same cart,
pays again, and the order is created once on success. Observed end to end on cart
`3a513b4f-0660-4b80-b732-5a27adf1f65c` — a declined attempt (`Authorization/Failure`) followed by a
successful one (`Authorization/Success` + `Charge/Success`) on the **same cart**, producing exactly one
order (`c10572fc`) that resolved to `Paid` because `resolveTargetPaymentState` ranks `Paid` above the
dead attempt. **`Failed` therefore stays in the event→state map for the processor's own path but must
not be presented as a state checkout orders reach.**

**`paymentMethodInfo.method` was empty while a bank transfer was `Pending` — fixed 2026-08-21 in
`53e7be3`.** Raised by Luis against a real Pending order (`ce54b7db`, `method: None`).

Root cause: `StripeEventConverter` filled the field only in the **Charge** branch, from
`payment_method_details.type`. Every `payment_intent.*` event took the other branch and left it
`undefined` — and for an asynchronous rail the settling Charge arrives days later, or never if the
shopper abandons the transfer, so the field was empty for exactly as long as anyone would want to look
at it.

The data is available at `requires_action`: the PaymentIntent carries `payment_method`
(`pm_1U6lHBL2sIzjTVbdICyjhIDd` → `type: customer_balance`). Fixed **generically** rather than for bank
transfer alone — `next_action.display_bank_transfer_instructions` would have identified a bank transfer
for free, but only a bank transfer, while the field is empty for every asynchronous rail; retrieving the
PaymentMethod costs the same one call and covers all of them.

Two properties that are load-bearing rather than defensive:

- **The retrieve lives in the service, not the converter**, which takes the answer as an optional
  parameter. The converter is a pure function of the payload — no I/O, no clock, no commercetools
  state — and that is what makes it exhaustively testable from fixtures. Doing the lookup there would
  have made `convert()` async and put a network call in the one place in this flow that has none.
- **Unresolved means `undefined`, never `''`.** These events arrive repeatedly for one payment and
  Stripe redelivers for three days; `''` would overwrite a method the Charge branch already wrote,
  turning a failed lookup into the erasure of a correct label.
- **The resolver never throws.** It sits in a webhook handler that must return non-2xx when a
  commercetools update fails so Stripe retries (KI-001). Mutating it to propagate fails 18 tests,
  including the pre-existing `partially_funded` gate — that blast radius is the reason for the rule.

**A correction to a technique used earlier in this work.** The "is this update action known?" probe —
send the action with no fields and read `RequiredField` vs `InvalidJsonInput` — is valid on the
**Checkout** API but **not** on the Orders API, which reports both missing and invalid fields as
`InvalidJsonInput` and puts the real reason in `detailedErrorMessage`. Applied to Orders it wrongly
reports perfectly valid actions as non-existent. Read `detailedErrorMessage` on Orders.

---

## The original decision, unchanged, follows below.

> **Numbering note.** `adr-008` is reserved for parallel work on `feature/ach-checkout`
> (`adr-008-connector-owns-order-paymentstate.md`), which reached the same core conclusion
> independently on 2026-08-15 — that the SDK's order service is read-only and the connector must
> update rather than create. This ADR was written on its own branch and deliberately does **not**
> merge that work; where the two agree, that agreement is corroboration from two independent
> investigations. Where they differ is recorded under Consequences.

## Context

`Order.paymentState` (`BalanceDue | Failed | Pending | CreditOwed | Paid`) is merchant-managed.
commercetools **never derives it** from the linked Payment's transaction states, and commercetools
Checkout creates the order **without** it. The official docs are explicit: *"The process to capture
funds after an Order is created is a business decision and your responsibility, as a merchant"* and
*"it's your responsibility to use Subscriptions to monitor payment outcomes and react accordingly."*

Measured on 2026-08-18 against a real deployment, bank-transfer rail, with simulated funding:

| | |
| --- | --- |
| PaymentIntent created | `02:40:41` |
| `payment_intent.requires_action` | `02:41:19` |
| **Order created by commercetools Checkout** | **`02:41:19.883`** |
| `payment_intent.succeeded` (funds applied) | `02:43:19` |

The order was created **two minutes before the money existed**, with `paymentState: null` — and was
never touched again (`lastModifiedAt == createdAt`) even after its Payment carried
`Authorization/Success` + `Charge/Success`.

**Why this went unseen.** A stale sibling deployment running pre-`0ab8d2c` legacy code
(`createOrderFromCart(cart, paymentState = PAID)`) was subscribed to the same Stripe account, received
the same events by webhook fan-out, and stamped `Paid` at order creation. Confirmed in the 2026-08-18
session by disabling its webhook — the order then came out stateless. That deployment was also the
source of the `409 ConcurrentModification` conflicts against current-code connectors. Decommissioning
it is environment cleanup, separate from this ADR, but **no measurement of `paymentState` on the
shared account is trustworthy until it is done.**

**Why "do it like the composable connector" is not available.** The composable connector converts
cart→order itself (`handlePaymentIntentSucceededFlow` → `createOrderFromCart(cart, PAID)` on
`payment_intent.succeeded`) because **it owns the cart**. This connector does not: commercetools
Checkout owns the cart and creates the order. `CommercetoolsOrderService` in connect-payments-sdk
0.27.2 exposes exactly one method — `getOrderByPaymentId()` — and no write, verified in the installed
SDK. This connector *did* create orders once; that code was removed in `0ab8d2c` **because** it raced
commercetools Checkout and produced 409s. Changing *when* the order is created is a commercetools ask,
not a code change on our side.

## Decision

The connector **reflects** the Stripe outcome onto the order commercetools already created, from the
webhook path, via `changePaymentState` — and **only for rails it had to hold open**.

1. **Two axes, two owners, two gates.** `Payment.transactions[].state` stays with the converter and
   is unchanged, including its bank-transfer-only `requires_action` gate. `Order.paymentState` is a
   new, separate path (`reflectOrderPaymentStateBestEffort`) whose `requires_action` handling is
   **method-agnostic**. A `requires_action` means the shopper committed and something intermediate
   stands in the way, which makes the *order* pending for every method; whether a pending
   *authorization* is booked is the narrower question and stays bank-transfer-only.
2. **Update, never create.** Resolve via `getOrderByPaymentId()`, issue `changePaymentState`. Never
   `createOrder`. Never write `orderState` or `shipmentState`.
3. **Asynchronous rails only.** A terminal state is written only when the connector owns the order —
   `order.paymentState === 'Pending'` (our own mark) or the Payment carries an
   `Authorization/Pending` (async rail). A synchronous card order is deliberately left unset, which
   is the site's/merchant's to finalize. This is the split agreed in the 2026-08-18 session.
4. **Monotonic transitions.** `Paid` is authoritative and never downgraded; `Failed → Paid` is
   allowed because a late wire beats an expiry prediction; `Pending` only ever lands on an unset
   order. Safe under redelivery and reordering. The 409 path **re-applies** the guard to the fresh
   state rather than replaying the original body.
5. **Bounded retry for a measured race.** The `Pending` lookup retries `[500, 1500]` ms because order
   creation lands ~883 ms after the event. Terminal targets do not retry.
6. **Best-effort as a contract.** The method never throws, so it cannot trip the
   `ASYNC_PENDING_EVENTS` rethrow path (KI-001) for a write that is not part of the payment record.
   The Payment remains the source of truth (ADR-003); the order's `paymentState` is a projection.
7. **Raw `ctAPI` for the write**, because the typed service is read-only — the pattern already used
   for customers. Needs `manage_orders`, already present in `requiredPermissions`, `connect.yaml`
   and `deployment.md`.

Mapping and per-method table: `business-rules/order-payment-state.md`.

## Alternatives Considered

| Alternative | Why discarded |
| --- | --- |
| **Merchant-side Subscription** sets `paymentState` | The architecturally "purest" fit and commercetools' own recommendation — retained as the preferred path if order finalization ever grows past `paymentState`. Rejected *for now* because it requires new infrastructure to build, deploy and operate, and the async rails need the loop closed before that exists. Note this ADR does not *block* it: an order the connector left unset (synchronous card) is exactly where a merchant process is expected to act. |
| **Site-side callbacks** for everything | Works for synchronous methods and is why they are left to it. Impossible for async: the money lands days later with no browser session in existence. |
| **Create the order on `succeeded`**, like composable | Not available — the SDK order service is read-only, and the removed `createOrderFromCart` raced commercetools Checkout into 409s. See Context. |
| **Write `paymentState` for every method**, including synchronous card | Simpler and one code path, but it takes over a responsibility commercetools explicitly assigns to the merchant, and it would fight any merchant Subscription doing the same job. |
| **Hardcode `Paid` at one point, unguarded** | The legacy behaviour. Wrong under redelivery/reordering, and cannot express `Pending` or `Failed` at all. |
| **Derive the order state by reducing the Payment's transactions** | Attractive, but with `Authorization` + `Charge` + `Refund` + `Chargeback` on one Payment the "winning" state is merchant policy, not a derivation. Mapping from the event keeps the function pure and the policy explicit. Revisit if refunds ever need to reach the order. |
| **Accept `paymentState = null`** | The measured status quo. The Payment holds the truth but operations cannot distinguish a paid order from an abandoned one — fails the requirement. |

## Consequences

> ## Verified end-to-end 2026-08-19 — one half holds, the other does not
>
> Measured on `stripe-checkout-dev-francisco` with simulated funding, EUR 34915 German carts:
>
> | Behaviour | Result |
> | --- | --- |
> | `Authorization/Pending` on the CT payment | ✅ 3/3 |
> | Order `paymentState: Paid` at settlement | ✅ 2/2 |
> | Order `paymentState: Pending` during the wait | ❌ **0/3** |
>
> **The terminal half of this ADR works and is the part that closes the original defect** — a paid
> order no longer stays unset. **The `Pending` half does not work**, for a structural reason this ADR
> got wrong: it assumed the order-creation lag was a bounded race worth retrying. Measured lag is
> 0.88 s / 3.8 s / 13 s, and in a fourth run the order was never created at all. See
> `business-rules/order-payment-state.md` Rule 4.
>
> Ownership signal 2 (decision item 3) is what saved both settlements: the `Pending` order write was
> missed each time and `Paid` still landed, because the discriminator lives on the **payment**, not
> the order. That was written as belt-and-braces and turned out to be the load-bearing half.
>
> **Superseding decision pending** — queue item `2026-08-19-031`. Candidates: a CT Connect `event`
> application subscribed to `OrderCreated` (precedent inside this integration:
> `ct-stripe-tax/order-syncer`, `MESSAGE_TYPE = ['OrderCreated']`, `applicationType: event`), or
> moving the `Pending` write to the storefront — which is what the 2026-08-18 session actually
> proposed and which this ADR mis-transcribed as "async ⇒ connector" for *both* states rather than
> splitting by **moment** (confirmation ⇒ storefront, days later ⇒ connector).

**Positive:** an async order now moves `null → Pending → Paid|Failed` with no stuck states.
`Pending` is visible in Merchant Center during the days-long wait, which is what makes an abandoned
transfer distinguishable from a paid one. One method-agnostic path covers every rail. Fully
reversible — the payment record is untouched, so a revert returns orders to unset.

**Negative:** one extra CT round-trip per mapped event, plus up to ~2 s of added webhook latency on
`requires_action` when the order-creation race is lost. Synchronous card orders still need a merchant
process, so the story is complete only in combination with one. `orderState` remains `Open`
regardless.

**Risks:**

- **Scope dependency.** Without `manage_orders` the write returns 403; best-effort logs and does not
  block. Verify at deploy.
- **Contended writes.** commercetools Checkout finishing its own order write is real contention; one
  409 retry covers it. A systematic conflict would surface as repeated warnings, not corruption.
- **Bank-transfer expiry is unverified.** Whether an unfunded transfer reliably emits a terminal
  event — and which — is not established. If none arrives the order stays `Pending` indefinitely.
  That is ADR-007's accepted stuck-Pending characteristic, now visible as `Pending` rather than
  invisible as `null`, which is an improvement but not a fix.
- **Divergence from `adr-008` on the parallel branch.** That work writes the terminal state for
  **every** method, including synchronous card, and does not hook `requires_action` at all. So the two
  differ in both directions: it finalizes synchronous card orders (which this ADR leaves to the
  merchant per the session decision) and it leaves bank transfer unset for the entire wait (because
  bank transfer never passes through `processing`). Reconciling them is a merge-time decision, not a
  silent precedence.

## Supersedes

**ADR-007, decision item 3** — *"The CT order is created only on `succeeded`, never during
`processing`."* That is true of the composable connector, which creates orders itself. It is false
here: post-`0ab8d2c` this connector does not create orders at all, and commercetools Checkout creates
them at completion without waiting for settlement. ADR-007 is amended in place; this ADR owns the
corrected claim.

## Related

- **ADR-003** — CT Payment as source of truth for transaction state. ADR-009 extends the same
  direction (Stripe events update CT, never the reverse) to the order's `paymentState`, as a
  projection rather than a second source of truth.
- **ADR-007** — the async-settlement `Authorization/Pending` model this builds on.
- **KI-017** — `requires_action` is method-dependent on the transaction axis, and now
  method-*independent* on the order axis.
- **KI-027 / queue `-026`** — the shopper still sees "Payment Failed". Different layer, still open.
