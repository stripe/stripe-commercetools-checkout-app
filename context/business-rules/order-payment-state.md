# Order Payment State

How a Stripe event becomes a commercetools state, on both of the two axes that exist — and which of
them this connector owns. `Order.paymentState` has two writers: the processor (on Stripe webhooks) and
the order-subscriber (on order creation); the rules below include the guards that keep them from
overwriting each other.

---

## The two axes

Confusing these is the single most common mistake in this area, so they are named before any rule.

| | `Payment.transactions[].state` | `Order.paymentState` |
| --- | --- | --- |
| Values | `Initial \| Pending \| Success \| Failure` | `BalanceDue \| Pending \| Paid \| CreditOwed \| Failed` |
| Written by | `StripeEventConverter.populateTransactions()` | `reflectOrderPaymentStateBestEffort()` (processor) and `writeOrderPaymentState()` (order-subscriber) |
| Mapping lives in | `stripeEventConverter.ts` (see `webhook-handling.md` Rule 3) | `ORDER_PAYMENT_STATE_BY_EVENT` in `utils.ts` (processor); `resolveTargetPaymentState()` in `order-subscriber/src/guard.ts` |
| Source of truth? | **Yes** | No. A projection of the Payment. |
| `requires_action` reaches it for | **bank transfer only** | **every payment method** |

They are separate objects with separate gates. See Rule 3 below for why that asymmetry is deliberate.

---

## Rule 1: commercetools never derives `Order.paymentState` — someone must write it

**What:** `Order.paymentState` changes only through the `changePaymentState` update action.
commercetools does **not** derive it from the linked Payment's transactions, and commercetools
Checkout creates the order **without** setting it. There is no Checkout Application setting or
platform toggle that finalizes it.

**Why:** commercetools assigns this to the merchant explicitly — *"The process to capture funds after
an Order is created is a business decision and your responsibility, as a merchant"*, and *"it's your
responsibility to use Subscriptions to monitor payment outcomes and react accordingly"*
(commercetools Checkout → Payments lifecycle).

**Invariant:** if neither a merchant process nor this connector writes it, `paymentState` stays
unset (`null`) forever, regardless of what the Payment's transactions say.

**Implementation:** `processor/src/services/stripe-payment.service.ts:2266-2387` →
`reflectOrderPaymentStateBestEffort()`; the write itself is `postOrderPaymentState()` (`:2567-2582`,
action at `:2578`). The write uses raw `paymentSDK.ctAPI.client.orders()`.
The order-subscriber writes the same action (`order-subscriber/src/clients/order.client.ts:194-205`).

---

## Rule 2: The connector owns the order state only for asynchronous rails

**What:** the processor writes a **terminal** `paymentState` (`Paid`/`Failed`) only when it owns that
order. Ownership requires either:

1. `order.paymentState === 'Pending'` — only this connector writes that, so it is our mark; **or**
2. the CT Payment carries an `Authorization/Pending` — written only by async rails (the converter's
   `processing`/`requires_action` cases, and the confirm gate's `PENDING` outcome).

A synchronous card payment satisfies neither, so **the processor** deliberately writes nothing for it.
That no longer means the order stays unset, because the `order-subscriber` records `Paid` for it at
`OrderCreated` instead (Rule 6). The processor declining and the order being unwritten are two
different statements.

**Why:** for a card that settles inline there is a live browser and a site callback at the moment of
truth, so finalizing the order is the site's/merchant's job. For an async rail the money lands
**days** later with no session in existence — nothing but the webhook can close the loop.

**Invariant:** a payment that never produced an `Authorization/Pending` never gets its order's
`paymentState` written to a terminal state by the processor — `writeOrderPaymentState` is reached with a
non-`Pending` target only after `connectorOwnsOrderPaymentState()` returns `true`.

**Implementation:** `processor/src/services/stripe-payment.service.ts:2472-2483` →
`connectorOwnsOrderPaymentState()`; applied at `:2307-2322`. Signal 2 depends on the call order in
Rule 8.

---

## Rule 3: `requires_action` reflects the order for every method, but books a transaction for bank transfer only

**What:** the two axes are gated differently, on purpose.

- `reflectOrderPaymentStateBestEffort()` is called for **all** `payment_intent.requires_action`
  events — card 3DS, Boleto, Blik, redirect methods, bank transfer, and **ACH microdeposits
  (`verify_with_microdeposits`)**. The ACH-microdeposits case confirms this rule's design: its
  `next_action.type` is **not** matched by `isBankTransferNextAction()`, so it books **no**
  payment-axis authorization (the Payment stays `Authorization/Initial`), yet the **order** axis still
  reflects it generically to `Pending` — exactly the asymmetry this rule describes.
- `processStripeEvent()` still receives `requires_action` **only** when
  `isBankTransferNextAction()` holds.

**Why:** a `requires_action` means the shopper committed to pay and an intermediate step stands in
the way. That makes the **order** pending for every method — the session's wording: *"si te llega un
require action significa que el usuario ya intentó pagar, pero hay un paso intermedio. Todos esos
deben estar pending."* Whether a pending **authorization** should also be booked is the narrower
question, and there the answer is still bank-transfer-only.

**Invariant:** widening `isBankTransferNextAction()` to serve the order axis is forbidden. The order
axis must never be routed through that predicate, and the transaction axis must never skip it. In
the `requires_action` case the reflection call is unconditional and precedes the predicate.

**Implementation:** `processor/src/routes/stripe-payment.route.ts:280-331` — the
`reflectOrderPaymentStateBestEffort()` call (`:322`) sits **above** the
`if (!isBankTransferNextAction(...))` guard (`:324`) in the merged
`requires_action`/`partially_funded` case. Predicate: `processor/src/utils.ts:84-87`.

---

## Rule 5: `Paid` is authoritative; the transition is monotonic

**What:** `shouldTransitionOrderPaymentState(current, target)` is the only place the processor's
decision is made.

| current ↓ / target → | `Pending` | `Paid` | `Failed` |
| --- | --- | --- | --- |
| unset | ✅ | ✅ | ✅ |
| `Pending` | ❌ no-op | ✅ | ✅ |
| `Failed` | ❌ | ✅ late settlement wins | ❌ no-op |
| `Paid` | ❌ | ❌ no-op | ❌ **never downgraded** |

**Why:** Stripe guarantees neither ordering nor exactly-once delivery, and redelivers for up to three
days. Three cells carry the weight:

- **`Paid` → `Failed` is refused.** Stripe emits `payment_intent.payment_failed` when a shopper's
  first card attempt is declined and a later attempt succeeds on the *same* PaymentIntent.
- **`Failed` → `Paid` is allowed.** A bank transfer whose instructions expired can still be funded if
  the wire was already in flight. Money is the fact; the timeout was a prediction.
- **`Pending` only onto an unset order** — it is the weakest state and must never overwrite a
  resolved one. This is also why `Pending` needs no ownership check. A `requires_action` redelivered
  after settlement therefore cannot move a resolved order back to pending.

The diagonal (`current === target`) is a no-op so a redelivered event issues no redundant
`changePaymentState`, avoiding a version bump and a pointless 409 window against a concurrent writer.

**Invariant:** pure and total — no I/O, no clock, no `Stripe.Event`. `shouldTransitionOrderPaymentState('Paid', t)`
is `false` for every `t`; `(current, 'Pending')` is `true` only when `current` is falsy; `(x, x)` is
`false`. A write that loses a 409 is re-decided from a fresh read, **never** a replay of the original
body: the processor re-applies this guard against the freshly fetched order, and the order-subscriber
re-resolves the whole write (guard and target) from a fresh read.

**Implementation:** `processor/src/utils.ts:154-159` → `shouldTransitionOrderPaymentState()` (diagonal
`:155`, `Paid` row `:156`, `Pending` column `:157`); applied at
`processor/src/services/stripe-payment.service.ts:2297-2305`; re-applied in `writeOrderPaymentState()`
after a `ConcurrentModification` (`:2524-2565`, re-check `:2541-2555`). Order-subscriber equivalent:
`order-subscriber/src/clients/order.client.ts:170-192` re-calls `resolveOrderForWrite()` on a 409
(`:175-185`).

---

## Rule 6: The subscriber records what is true at `OrderCreated`, onto an empty field only

**What:** on every `OrderCreated` (and `OrderCreatedFromRecurringOrder`) for an order paid through this
connector, the `order-subscriber` reads the order **fresh**, resolves the payment's own transactions to
a state, and writes it — but only when `paymentState` is unset.

| At the moment the order is created | → `paymentState` |
| --- | --- |
| any of our payments has a `Charge/Success` **and the order's charges cover its gross total** (Rule 9) | `Paid` |
| any of our payments has a `Charge/Success` but the charges do **not** cover the gross | **nothing written** — manual review (Rule 9) |
| else, any has an `Authorization/Pending` | `Pending` |
| else (`Authorization/Success` with no charge — manual capture) | **nothing written** |
| else (only failures, no transactions, unexpanded) | **nothing written** |

`Paid` outranks `Pending` rather than being checked after it; for a retried checkout the precedence
is load-bearing.

**Why:** this is the only writer that can see a card. The order is created **after** a card settles
(measured 333/701/877 ms), so the processor's `succeeded` handler finds no order, gets a single
lookup attempt for a terminal target, and skips — and nothing else ever fires. The subscriber runs
on `OrderCreated`, by which point the order provably exists and the payment is readable.

**The read must be fresh, never the message payload.** The Pub/Sub snapshot's `paymentState` is always
empty on `OrderCreated`, but between the message and now the webhook path may already have written
`Paid`; guarding against the payload would see empty and overwrite a real state
(`order-subscriber/src/clients/order.client.ts:18-33`). The decoded message type carries no
`paymentState` at all (`order-subscriber/src/validators/message.validator.ts:4-8`) and `classify()`
returns only an order id (`:37-40`).

**Manual capture is deliberately unwritten.** Under `STRIPE_CAPTURE_METHOD=manual` a card arrives
authorized but not captured. `Paid` would be false and `Pending` misdescribes it — nothing is awaited
from the shopper; the merchant simply has not captured. This is the one case where "the merchant
process decides" is honest, because the merchant is the actor. `BalanceDue` is the commercetools
state that fits and stays out of scope (see *What this deliberately does not do*). Adding it is a
product decision. Deployments observed so far run `automatic`, but the value is
configurable, so the case is reachable in the field.

**Invariant:** the subscriber **never changes an existing `paymentState`** — it reflects onto an
empty field and never transitions: a write is attempted only when `shouldWritePending(order.paymentState)`
is `true` on the **freshly read** order. This is why Rule 5's lattice is not duplicated in that module:
there is no matrix to drift, only "what is true right now". Both race directions resolve without it —
if the processor writes first the subscriber finds the field occupied and skips; if the subscriber
writes `Paid` and `succeeded` arrives later, Rule 5 sees `Paid → Paid` and no-ops.

**Implementation:** `order-subscriber/src/guard.ts:189-206` → `resolveTargetPaymentState()` (what is
true; `Paid` precedence `:201-203`, `Pending` `:204`, manual capture `:205`) and `:24` →
`shouldWritePending()` (is the field free); applied in `order-subscriber/src/clients/order.client.ts:38-122`
→ `resolveOrderForWrite()` — fresh read with payments expanded `:41-45`, guard `:59-65`, then the
`paymentInterface` filter `:67-74` (Rule 7), so a sibling connector's rail can never decide our write.

At `OrderCreated`, by rail:

| Rail | Transactions at `OrderCreated` | `paymentState` |
| --- | --- | --- |
| card, no 3DS | `Authorization/Success` + `Charge/Success` | `Paid` |
| card, 3DS challenge authenticated | same, behind a dead `Authorization/Initial` | `Paid` |
| Amazon Pay (redirect, shopper returned) | same | `Paid` |
| bank transfer | `Authorization/Pending` | `Pending` → `Paid` on funding |
| declined then retried on the same cart | `Authorization/Failure` + settled attempt | `Paid` |
| manual capture (synthetic) | `Authorization/Success`, no charge | not written |
| redirect abandoned | — | **no order exists at all** |

A **completed** redirect rail behaves exactly like a card — not a third category; only an *abandoned*
one is, and it produces no order. A **declined** attempt produces no order either, which is intended,
so `Failed` is not a state a **synchronously-declined** checkout order reaches — no order exists to
mark. It **is** reached by **async** rails whose order was already created before the debit resolved:
an ACH debit returning `insufficient_funds`/`no_account` after the pending window leaves an order the
processor marks `Failed` via `payment_intent.payment_failed`, consistent with the Axis-1 table above.

**`paymentMethodInfo.method` is filled for asynchronous rails too:** the service resolves the type
from the PaymentIntent's `payment_method` and passes it in, generically for every rail rather than for
bank transfer alone (`processor/src/services/stripe-payment.service.ts:1974-1998`). An unresolved
method stays `undefined` rather than `''`.

---

## Rule 7: The subscriber decides involvement from this connector's payments only

**What:** only payments whose `paymentMethodInfo.paymentInterface` equals `'checkout-stripe'` decide
**whether** the subscriber writes and whether the state is `Pending`; an order with none of them is
skipped. Coverage for `Paid` is the one exception — it is summed over **all** the order's expanded
payments (Rule 9).

**Why:** `OrderCreated` is delivered for every order in the project, including other connectors' and
hand-made ones (`order-subscriber/src/constants.ts:25-38`). Returning all matches rather than the first
is deliberate: a retried checkout leaves several payments on one order, and `payments[0]` would judge
the order by whichever attempt happens to be first (`order.client.ts:124-135`).

**Invariant:** `resolveTargetPaymentState` receives the interface-filtered set as `ourPayments`, an empty
filtered set returns without writing, and a sibling connector's charge with no charge of ours writes
nothing.

**Implementation:** `order-subscriber/src/clients/order.client.ts:67-74` (filter and skip), `:136-139`
(`ourPayments`), `:150-151` (`allExpandedPayments`, coverage only); constant
`order-subscriber/src/constants.ts:39`.

---

## Rule 8: Order reflection runs before the payment update on every event that has both

**What:** in every webhook case block that calls both, `reflectOrderPaymentStateBestEffort()` is called
**before** `processStripeEvent()`.

**Why:** ownership signal 2 (Rule 2) reads the `Authorization/Pending` that `processStripeEvent()` →
`transitionPendingAuthorizationToSuccess()` flips to `Success` on `payment_intent.succeeded`
(`processor/src/routes/stripe-payment.route.ts:261-267`; `stripe-payment.service.ts:2467-2470`).

**Invariant:** in each case block of the webhook route, the reflection call precedes `processStripeEvent`.

**Implementation:** `processor/src/routes/stripe-payment.route.ts:268-269` (`succeeded`/`charge.succeeded`),
`:277-278` (`processing`/`canceled`/`payment_failed`), `:322-329` (`requires_action`/`partially_funded`).

---

## Rule 9: `Paid` is written only when settled money covers the order's gross total

**What:** neither writer stamps `Paid` unless the settled amount, in the order's currency, is at least
the order's tax-inclusive gross (`order.taxedPrice?.totalGross ?? order.totalPrice`). Coverage counts
the `Charge/Success` of **every** payment on the order (split tender), not only ours. The settled amount
is sourced differently per writer:

- **Processor (async rails, settlement webhook):** our leg is the settling PaymentIntent's
  `amount_received` (the route reflects **before** our `Charge/Success` is persisted, Rule 8), plus the
  persisted `Charge/Success` of the order's **other** payments.
- **Order-subscriber (`OrderCreated`):** the sum of persisted `Charge/Success` across all expanded
  payments, since the charge is already written by then.

On undercoverage, nothing is written; the result is left for manual review. `Pending` is never gated
by coverage.

**Why:** the comparison is tax-inclusive because Stripe charges tax-inclusive.

**Invariant:** `amountCoversOrderTotal(settled, settledCurrency, gross)` — same currency
(case-insensitive) **and** `settled >= gross` — gates every `Paid` write, and the function is
byte-identical in both apps (they cannot share code: separate Connect `deployAs` units, `rootDir: ./src`).

**Implementation:** pure rule `processor/src/utils.ts:200-206` and `order-subscriber/src/guard.ts:81-87`.
Processor sourcing and gate: `processor/src/services/stripe-payment.service.ts:2324-2369`, other
payments `:2500-2513` (`sumOtherPaymentsCharges`). Subscriber sourcing: `order-subscriber/src/guard.ts:96-130`
(`sumSuccessfulCharges`, `chargesCoverOrderTotal`), gate `:201-203`; gross and logging
`order-subscriber/src/clients/order.client.ts:76-114`.

---

## Rule 10: Order reflection never fails the webhook

**What:** any error while reflecting the order state is caught and logged (scalars only); the method
returns normally.

**Why:** best-effort is a contract, not a caveat. `processStripeEvent()` rethrows for
`ASYNC_PENDING_EVENTS` so Stripe retries a failed CT write
(`processor/src/services/stripe-payment.service.ts:2258-2262`; route comment
`stripe-payment.route.ts:320-321`).

**Invariant:** `reflectOrderPaymentStateBestEffort` has no code path that throws: the pre-`try` lines
only read a constant map and return, and the body is a single `try` whose `catch` neither throws nor
rethrows.

**Implementation:** `processor/src/services/stripe-payment.service.ts:2266-2387` (`try` `:2272`, `catch`
`:2372-2386`); the coverage guard's fetch errors land in the same `catch` (`:2350-2354`).

---

## The reference table

### Axis 1 — `Order.paymentState` (this connector)

**Two writers, two triggers.** The table below is the **processor's**, driven by Stripe events. The
`order-subscriber` is the second writer and is not event-driven at all — it fires once per
`OrderCreated` and is governed by Rule 6, not by this table. For a card the processor writes nothing
(no order exists yet) and the subscriber writes everything; for a bank transfer the subscriber writes
`Pending` and the processor writes the settlement.

| Trigger | Writer | Governed by |
| --- | --- | --- |
| Stripe webhook event | `processor` | this table + Rule 2 + Rule 5 + Rule 9 |
| commercetools `OrderCreated` / `OrderCreatedFromRecurringOrder` | `order-subscriber` | Rules 6, 7, 9 |

Processor path, by event:

| Stripe event | → `Order.paymentState` | Gate |
| --- | --- | --- |
| `payment_intent.requires_action` | `Pending` | all methods; retry on order-not-yet-created |
| `payment_intent.processing` | `Pending` | all methods |
| `payment_intent.succeeded` | `Paid` | ownership required (Rule 2) **and coverage (Rule 9)** |
| `payment_intent.payment_failed` | `Failed` | ownership required |
| `payment_intent.canceled` | `Failed` | ownership required |
| `payment_intent.partially_funded` | — *(no write)* | still pending; order already says so |
| `charge.succeeded` / `charge.updated` | — *(no write)* | `payment_intent.succeeded` already covers settlement |
| `charge.refunded`, `refund.updated`, `refund.failed` | — *(no write)* | `CreditOwed` is a merchant decision — **deferred**, see Open questions |
| `customer_cash_balance_transaction.created` | — *(no write)* | customer-scoped; carries no `ct_payment_id` |

### Axis 2 — `Payment.transactions[].state`

Owned by the converter and **documented in `webhook-handling.md` Rule 3**. Read it there.

### Per-method behaviour

This connector does **not** enumerate payment methods in code —
`getSupportedPaymentComponents()` returns a single generic Payment Element plus Express, and Stripe
decides at runtime which methods render from account/currency/country. So this table is indexed by
the event sequence a method produces, not by a registry. Only bank transfer, crypto, Blik and 3DS
have method-specific code at all.

| Method | Settlement | Event sequence | Resulting order states |
| --- | --- | --- | --- |
| Card (no 3DS) | sync | `succeeded` | **`Paid`, written by the order-subscriber at `OrderCreated`** (Rule 6) |
| Card + 3DS | sync, client action | `requires_action` → `succeeded` | **`Paid`** (subscriber) — the processor finds no order to write (Rule 2) and 3DS books no `Authorization/Pending`, so it would not own one anyway |
| Bank transfer (`customer_balance`) | async, **days** | `requires_action` → *(`partially_funded`)* → `succeeded` | `Pending` → `Paid` |
| Crypto / stablecoin | async, minutes | `processing` → `succeeded` | `Pending` → `Paid` |
| Boleto | async, days | `requires_action` → `succeeded` | `Pending` → `Paid` |
| Blik | sync, 60 s window | `requires_action` (`blik_authorize`) → `succeeded` | `Pending` → `Paid` |
| ACH (`us_bank_account`) | async, days | success→`succeeded`; indefinite→`processing`; microdeposits→`requires_action`(`verify_with_microdeposits`)→verify→`processing`→`succeeded`; async fail (`insufficient_funds`/`no_account`)→`payment_failed`; sync reject (`charge_exceeds_source_limit`)→confirm rejected | `Pending`→`Paid`; async fail→**`Failed`** (order exists); sync reject→**no order** (cart Active) |
| Redirect methods (iDEAL, Klarna, P24…) | mostly sync | `requires_action` (`redirect_to_url`) → `succeeded` | `Pending` → `Paid` |
| Wallets (Apple/Google Pay, Express) | sync | `succeeded` | **`Paid` via the order-subscriber** (same path as a card) |
| Pix / voucher / QR rails | async | `requires_action` → `succeeded`/expiry | `Pending` → `Paid`/`Failed` |

---

## What this deliberately does not do

- **No `BalanceDue`, no `CreditOwed`.** `OrderPaymentState` in `stripe-payment.type.ts` (`:89-93`)
  carries three members, and the narrowness is the contract: every member is derivable from a Stripe
  event with no merchant policy input. `BalanceDue` is indistinguishable from the unset state Rule 2
  preserves. The subscriber writes only `Paid` and `Pending` (`order-subscriber/src/guard.ts:42`).
- **Refunds and disputes do not touch the order.** They remain a Payment-transaction concern
  (`refunds-reversals.md`).
- **`orderState` is never written** — only `paymentState`. Order lifecycle (`Open`/`Complete`) and
  `shipmentState` stay entirely the merchant's.
- **The order is never created.** See Rule 1.
- **A settled-but-short order is not marked anything.** Undercoverage (Rule 9) is left unset for
  manual review, never `Pending`.

## Open questions

1. **Refund → `CreditOwed`?** Does a partially refunded order stop being `Paid`? Raised and
   explicitly deferred as a merchant business decision.
2. **Which transaction wins for the order?** With `Authorization` + `Charge` + `Refund` +
   `Chargeback` on one Payment, the "general" order state is a policy, not a derivation. Currently
   settled by mapping from the **event**, not by reducing transactions.
