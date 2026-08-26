# Order Payment State

How a Stripe event becomes a commercetools state, on both of the two axes that exist — and which of
them this connector owns.

> **Added 2026-08-18 (SB3-207 task 028).** Requested in the 2026-08-18 session as a single reference
> table so the event→state agreement is loaded with the rest of `context/` instead of being
> re-derived per task. The decision behind it is `decisions/adr-009-order-payment-state-reflection.md`.

---

## The two axes

Confusing these is the single most common mistake in this area, so they are named before any rule.

| | `Payment.transactions[].state` | `Order.paymentState` |
| --- | --- | --- |
| Values | `Initial \| Pending \| Success \| Failure` | `BalanceDue \| Pending \| Paid \| CreditOwed \| Failed` |
| Written by | `StripeEventConverter.populateTransactions()` | `reflectOrderPaymentStateBestEffort()` |
| Mapping lives in | `stripeEventConverter.ts` (see `webhook-handling.md` Rule 3) | `ORDER_PAYMENT_STATE_BY_EVENT` in `utils.ts` |
| Source of truth? | **Yes** — ADR-003 | No. A projection of the Payment. |
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

**Implementation:** `stripe-payment.service.ts` → `reflectOrderPaymentStateBestEffort()`. The write
uses raw `paymentSDK.ctAPI.client.orders()` because `CommercetoolsOrderService` in
connect-payments-sdk 0.27.2 exposes only `getOrderByPaymentId()` — verified in the installed SDK.

**Closure criterion:** `grep -n "changePaymentState" processor/src/services/stripe-payment.service.ts`
— exactly one call site.

**What breaks if violated:** measured 2026-08-18 — the order sat at `orderState: Open`,
`paymentState: null`, `lastModifiedAt == createdAt`, while its Payment already carried
`Authorization/Success` + `Charge/Success`. Operations cannot tell a paid order from an abandoned one.

> **Why nobody noticed for months.** A stale sibling deployment running pre-`0ab8d2c` legacy code
> (`createOrderFromCart(cart, PAID)`) received the same webhooks by fan-out on the shared Stripe
> account and stamped `Paid` at order creation. Confirmed in the 2026-08-18 session by disabling its
> webhook: the order then came out with no state. That deployment was also the source of the
> `409 ConcurrentModification` conflicts. **Any `paymentState` measured on the shared Stripe account
> is contaminated while a legacy deployment is still subscribed** — an observed `Paid` is not
> evidence that your branch wrote it.

---

## Rule 2: The connector owns the order state only for asynchronous rails

> **Amended 2026-08-20 — scope narrowed to the processor; the "leave a card unset" half is
> superseded.** This rule still describes the **processor's** webhook path exactly as written. What
> changed is that the processor is no longer the only writer: the `order-subscriber` now records the
> payment's state at `OrderCreated`, including `Paid` for a card. The reason is measured, not
> preferential — for a card commercetools Checkout creates the order **after** the money settles
> (333 ms / 701 ms / 877 ms in three real runs), so `payment_intent.succeeded` reaches the processor
> with no order to write, terminal targets get one lookup attempt with no retry, and **no later event
> ever arrives**. "Left unset for the site to finalize" was therefore never a division of labour in
> practice; it was an order nobody recorded. The 2026-08-18 premise that a live browser and a site
> callback would close that loop did not hold: the sample site does not do it, and a merchant
> installing a payments connector reasonably expects the connector to record payment state.
> Reversal requested by Luis and recorded in ADR-009 (Amendment, 2026-08-20). See Rule 6 for the writer and
> for the one case still deliberately left to the merchant.

**What:** the connector writes a **terminal** `paymentState` (`Paid`/`Failed`) only when it owns that
order. Ownership requires either:

1. `order.paymentState === 'Pending'` — only this connector writes that, so it is our mark; **or**
2. the CT Payment carries an `Authorization/Pending` — written only by async rails (the converter's
   `processing`/`requires_action` cases, and the confirm gate's `PENDING` outcome).

A synchronous card payment satisfies neither, so **the processor** deliberately writes nothing for it.
That is still correct and still tested — but as of 2026-08-20 it no longer means the order stays
unset, because the `order-subscriber` records `Paid` for it at `OrderCreated` instead (Rule 6). The
processor declining and the order being unwritten are now two different statements.

**Why:** the division agreed in the 2026-08-18 session. For a card that settles inline there is a
live browser and a site callback at the moment of truth, so finalizing the order is the
site's/merchant's job. For an async rail the money lands **days** later with no session in
existence — nothing but the webhook can close the loop.

**Invariant:** a payment that never produced an `Authorization/Pending` never gets its order's
`paymentState` written by this connector.

**Implementation:** `stripe-payment.service.ts` → `connectorOwnsOrderPaymentState()`.

**Closure criterion:** the release gate `does NOT write on succeeded for a synchronous card payment`
in `test/services/stripe-payment.service.spec.ts`, paired with its mirror
`DOES write Paid on succeeded when the order is already Pending`.

**What breaks if violated:** dropping signal 1 makes the connector claim order state it agreed not
to own, and any merchant Subscription doing the same job starts fighting it with 409s. Dropping
signal 2 is worse and quieter: a `Pending` write that lost the creation race (Rule 4) would make the
settlement write get skipped too, so a bank transfer that **was paid** keeps an unset order forever.

---

## Rule 3: `requires_action` reflects the order for every method, but books a transaction for bank transfer only

**What:** the two axes are gated differently, on purpose.

- `reflectOrderPaymentStateBestEffort()` is called for **all** `payment_intent.requires_action`
  events — card 3DS, Boleto, Blik, redirect methods, bank transfer.
- `processStripeEvent()` still receives `requires_action` **only** when
  `isBankTransferNextAction()` holds.

**Why:** a `requires_action` means the shopper committed to pay and an intermediate step stands in
the way. That makes the **order** pending for every method — the session's wording: *"si te llega un
require action significa que el usuario ya intentó pagar, pero hay un paso intermedio. Todos esos
deben estar pending."* Whether a pending **authorization** should also be booked is the narrower
question, and there the answer is still bank-transfer-only: booking one for every 3DS payment is the
most severe regression this feature can cause (KI-017).

**Invariant:** widening `isBankTransferNextAction()` to serve the order axis is forbidden. The order
axis must never be routed through that predicate, and the transaction axis must never bypass it.

**Implementation:** `stripe-payment.route.ts` — the `reflectOrderPaymentStateBestEffort()` call sits
**above** the `if (!isBankTransferNextAction(...))` guard in the merged
`requires_action`/`partially_funded` case.

**Closure criterion:** the `GATE SPLIT:` tests in `test/routes.test/stripe-payment.spec.ts` assert,
for 3DS and Boleto, that the order axis **is** driven and the transaction axis is **not** — plus the
mirror asserting a bank transfer drives both.

**What breaks if violated:** unifying the gates in the permissive direction writes an
`Authorization/Pending` on every 3DS card payment. Unifying them in the restrictive direction leaves
3DS, Boleto and Blik orders unset while looking correct in a diff, because both gates would then
"agree".

---

## Rule 4: The webhook always precedes order creation — the lag is variable and the wait is bounded

**What:** for a `Pending` target the order lookup retries on the schedule
`ORDER_LOOKUP_RETRY_DELAYS_MS` (`[500, 1500, 3000, 6000]` ms, 5 attempts, ~11 s worst case). Terminal
targets do **not** retry. Exhausting a `Pending` target logs at **warn**.

**Why:** `payment_intent.requires_action` **always** fires before commercetools Checkout creates the
order — CT creates it when the shopper completes checkout, which is necessarily after the
PaymentIntent is confirmed. So the first lookup always loses; only the margin varies. Calling this a
"race" invites 50/50 reasoning and the wrong sizing. `getOrderByPaymentId()` **throws**
`ErrorReferencedResourceNotFound` when its predicate matches anything other than exactly one order —
including zero — so "not created yet" arrives as a throw, not an empty result.

Measured lag, `requires_action` → order created:

| Run | Lag | Result |
| --- | --- | --- |
| 2026-08-18 02:41:19 | 0.88 s | — (window was 2 s, but this run predates the feature) |
| 2026-08-18 23:12:58 | 3.8 s | ❌ missed with a 2 s window, by 425 ms |
| 2026-08-19 00:17:13 | **13 s** | ❌ missed with an **11 s** window |
| 2026-08-19 00:06:52 | **order never created** | checkout abandoned via the hosted-instructions redirect — the PaymentIntent stayed live in `requires_action` with an `Authorization/Pending` on the CT payment, and no order existed 8 minutes later |

> ## ⚠️ THE RETRY DOES NOT WORK, AND WIDENING IT IS THE WRONG RESPONSE
>
> **Measured 0 for 3.** Read the table before touching `ORDER_LOOKUP_RETRY_DELAYS_MS`.
>
> The schedule shipped as `[500, 1500]`, sized off the 0.88 s sample **alone**. Run 2 missed by
> 425 ms, so it was widened to `[500, 1500, 3000, 6000]` (~11 s). Run 3 measured **13 s** and missed
> again. Three samples spanning 0.88 s → 13 s is a factor of **15 and not converging**.
>
> **There is no reasonable fixed window, and each retry is real webhook latency** — this route
> answers 200 only after processing completes. Widening a third time would be the third iteration of
> the same mistake: fitting a number to the most recent sample.
>
> **The mechanism is wrong, not the sizing.** The write is in the wrong place. The webhook always
> precedes order creation *by construction*; the storefront's own completion callback fires *after*
> it, also by construction. Retrying inside the webhook handler is waiting for an event in the one
> place that event cannot happen. Run 4 makes it worse: sometimes the order is **never** created at
> all, so no window of any size would help.
>
> **What actually works, and is unaffected:** `Authorization/Pending` on the CT payment (3/3 runs)
> and the terminal `Paid` write at settlement (2/2 runs, recovered through ownership signal 2 in
> Rule 2 — the `Pending` order write was missed both times and `Paid` still landed).
>
> **Open decision** — see `decisions/adr-009` Consequences and queue item `2026-08-19-031`. The
> candidates are a CT Connect `event` application subscribed to `OrderCreated` (precedent:
> `ct-stripe-tax/order-syncer`, `MESSAGE_TYPE = ['OrderCreated']`), or moving the `Pending` write to
> the storefront, which is what the 2026-08-18 session actually proposed. Until that is settled the
> current schedule is left as-is: it is harmless, it catches a fast case if one occurs, and it must
> **not** be read as a working mechanism.

**Invariant:** the retry applies to `Pending` targets only, and exhausting one must be logged at a
level that is visible. This route answers 200 only after processing completes, so every retry is real
webhook latency.

**Implementation:** `stripe-payment.service.ts` → `resolveOrderForPaymentStateReflection()`.

**Closure criterion:** `gives up after the full retry schedule and never throws` asserts the exact
schedule **and** the warn; `does NOT retry the lookup for a terminal target` asserts the terminal
case stays at info.

**What breaks if violated:** the failure is asymmetric. Too short and the `Pending` write is lost —
recoverable at settlement through ownership signal 2 (Rule 2), so a paid order still reaches `Paid`,
but an **abandoned** transfer emits no further event and its order stays unset forever,
indistinguishable from a card order that never got a webhook. That is the exact ambiguity this
feature exists to remove. Too long only adds latency, and only on the branch where the order really
is not there yet. Logging the exhaustion at `info` — as the first version did — makes the degradation
invisible: the 23:12 miss was only found by inspecting the order by hand.

---

## Rule 5: `Paid` is authoritative; the transition is monotonic

**What:** `shouldTransitionOrderPaymentState(current, target)` is the only place the decision is made.

| current ↓ / target → | `Pending` | `Paid` | `Failed` |
| --- | --- | --- | --- |
| unset | ✅ | ✅ | ✅ |
| `Pending` | ❌ no-op | ✅ | ✅ |
| `Failed` | ❌ | ✅ late settlement wins | ❌ no-op |
| `Paid` | ❌ | ❌ no-op | ❌ **never downgraded** |

**Why:** Stripe guarantees neither ordering nor exactly-once delivery, and redelivers for up to three
days. Three cells carry the weight:

- **`Paid` → `Failed` is refused.** Stripe emits `payment_intent.payment_failed` when a shopper's
  first card attempt is declined and a later attempt succeeds on the *same* PaymentIntent. Allowing
  the downgrade marks a genuinely paid order as failed.
- **`Failed` → `Paid` is allowed.** A bank transfer whose instructions expired can still be funded if
  the wire was already in flight. Money is the fact; the timeout was a prediction.
- **`Pending` only onto an unset order** — it is the weakest state and must never overwrite a
  resolved one. This is also why `Pending` needs no ownership check.

**Invariant:** pure and total — no I/O, no clock, no `Stripe.Event`. The 409 retry path must
**re-apply** this guard against the freshly fetched state, never replay the original body.

**Implementation:** `utils.ts` → `shouldTransitionOrderPaymentState()`; re-applied in
`writeOrderPaymentState()` after a `ConcurrentModification`.

**Closure criterion:** the exhaustive matrix in `test/utils/utils.spec.ts`, plus
`re-applies the transition guard after a 409 and abandons if the winner already resolved it`.

**What breaks if violated:** a paid order flips to `Failed` on a redelivered or out-of-order event
and the merchant stops fulfilling it. Re-reading the fresh version *without* re-applying the guard is
the quiet way to reintroduce exactly that.

---

## Rule 6: The subscriber records what is true at `OrderCreated`, onto an empty field only

**What:** on every `OrderCreated` for an order paid through this connector, the `order-subscriber`
reads the order **fresh**, resolves the payment's own transactions to a state, and writes it — but
only when `paymentState` is unset.

| At the moment the order is created | → `paymentState` |
| --- | --- |
| any of our payments has a `Charge/Success` | `Paid` |
| else, any has an `Authorization/Pending` | `Pending` |
| else (`Authorization/Success` with no charge — manual capture) | **nothing written** |
| else (only failures, no transactions, unexpanded) | **nothing written** |

`Paid` outranks `Pending` rather than being checked after it. For a retried checkout the precedence
is load-bearing: an abandoned bank transfer leaves its `Authorization/Pending` on the order forever,
so ranking the other way would freeze a subsequently-card-paid order as pending while the money sat
in the account.

**Why:** this is the only writer that can see a card. The order is created **after** a card settles
(measured 333/701/877 ms), so the processor's `succeeded` handler finds no order, gets a single
lookup attempt for a terminal target, and skips — and nothing else ever fires. The subscriber runs
on `OrderCreated`, by which point the order provably exists and the payment is readable.

**Manual capture is deliberately unwritten.** Under `STRIPE_CAPTURE_METHOD=manual` a card arrives
authorized but not captured. `Paid` would be false and `Pending` misdescribes it — nothing is awaited
from the shopper; the merchant simply has not captured. This is the one case where "the merchant
process decides" is honest, because the merchant is the actor. `BalanceDue` is the commercetools
state that fits and stays out of scope (see *What this deliberately does not do*). Adding it is a
product decision, not a fix. Deployments observed so far run `automatic`, but the value is
configurable, so the case is reachable in the field.

**Invariant:** the subscriber **never changes an existing `paymentState`** — it reflects onto an
empty field and never transitions. This is why Rule 5's lattice is not duplicated in that module:
there is no matrix to drift, only "what is true right now". Both race directions resolve without it —
if the processor writes first the subscriber finds the field occupied and skips; if the subscriber
writes `Paid` and `succeeded` arrives later, Rule 5 sees `Paid → Paid` and no-ops.

**Implementation:** `order-subscriber/src/guard.ts` → `resolveTargetPaymentState()` (what is true) and
`shouldWritePending()` (is the field free); applied in `order.client.ts` → `resolveOrderForWrite()`,
**after** the `paymentInterface` filter, so a sibling connector's rail can never decide our write.

**Closure criterion:** in `order-subscriber/test/guard.spec.ts`, three release gates plus a mirror —
the three real card fixtures resolve to `Paid`, an awaiting bank transfer resolves to `Pending` and
never `Paid`, and an authorization with no charge resolves to nothing. Mutation-verified 2026-08-20 in
five directions: always-`Paid`, always-`Pending`, always-`undefined`, inverted precedence, and
treating `Authorization/Success` as `Paid` each fail the suite.

**What breaks if violated:** returning `Paid` too eagerly marks an **unfunded** bank transfer as paid
— the most expensive failure this module can produce, because fulfilment starts on money that has not
arrived. Returning `Pending` too eagerly is the defect this rule replaced: on 2026-08-20 three
settled cards were recorded as pending with no event able to correct them, which is worse than an
empty field because it is a wrong answer signed by this connector.

**Verified end to end on 2026-08-21**, through the browser against real Stripe, on the deployed build:

| Rail | Transactions at `OrderCreated` | `paymentState` |
| --- | --- | --- |
| card, no 3DS | `Authorization/Success` + `Charge/Success` | `Paid` |
| card, 3DS challenge authenticated | same, behind a dead `Authorization/Initial` | `Paid` |
| Amazon Pay (redirect, shopper returned) | same | `Paid` |
| bank transfer | `Authorization/Pending` | `Pending` → `Paid` on funding |
| declined then retried on the same cart | `Authorization/Failure` + settled attempt | `Paid` |
| manual capture (synthetic) | `Authorization/Success`, no charge | not written |
| redirect abandoned | — | **no order exists at all** |

Two things that table settles. A **completed** redirect rail behaves exactly like a card — it is not a
third category; only an *abandoned* one is, and it produces no order to be wrong about. And a
**declined** attempt produces no order either, which is the intended behaviour (see ADR-009 follow-up),
so `Failed` is not a state a checkout order reaches.

**`paymentMethodInfo.method` is now filled for asynchronous rails too** (fixed 2026-08-21, `53e7be3`).
It used to be empty for the whole time a bank transfer sat at `Pending`, because the converter took it
from a Charge and the settling Charge arrives days later — or never. The service now resolves the type
from the PaymentIntent's `payment_method` and passes it in, generically for every rail rather than for
bank transfer alone. See the ADR-009 follow-up for why the lookup lives in the service and why an
unresolved method must stay `undefined` rather than `''`.

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
| Stripe webhook event | `processor` | this table + Rule 2 + Rule 5 |
| commercetools `OrderCreated` | `order-subscriber` | Rule 6 |

Processor path, by event:

| Stripe event | → `Order.paymentState` | Gate |
| --- | --- | --- |
| `payment_intent.requires_action` | `Pending` | all methods; retry on order-not-yet-created |
| `payment_intent.processing` | `Pending` | all methods |
| `payment_intent.succeeded` | `Paid` | ownership required (Rule 2) |
| `payment_intent.payment_failed` | `Failed` | ownership required |
| `payment_intent.canceled` | `Failed` | ownership required |
| `payment_intent.partially_funded` | — *(no write)* | still pending; order already says so |
| `charge.succeeded` / `charge.updated` | — *(no write)* | `payment_intent.succeeded` already covers settlement |
| `charge.refunded`, `refund.updated`, `refund.failed` | — *(no write)* | `CreditOwed` is a merchant decision — **deferred**, see Open questions |
| `customer_cash_balance_transaction.created` | — *(no write)* | customer-scoped; carries no `ct_payment_id` |

### Axis 2 — `Payment.transactions[].state`

Owned by the converter and **documented in `webhook-handling.md` Rule 3**. Not reproduced here: an
inline copy of that table went stale twice already. Read it there.

### Per-method behaviour

**How to read the Verified column.** This connector does **not** enumerate payment methods in code —
`getSupportedPaymentComponents()` returns a single generic Payment Element plus Express, and Stripe
decides at runtime which methods render from account/currency/country. So this table is indexed by
the event sequence a method produces, not by a registry. Only bank transfer, crypto, Blik and 3DS
have method-specific code at all.

| Method | Settlement | Event sequence | Resulting order states | Verified |
| --- | --- | --- | --- | --- |
| Card (no 3DS) | sync | `succeeded` | **unset** — site's job (Rule 2) | ✅ measured |
| Card + 3DS | sync, client action | `requires_action` → `succeeded` | `Pending` → `Paid` | ✅ code + fixtures |
| Bank transfer (`customer_balance`) | async, **days** | `requires_action` → *(`partially_funded`)* → `succeeded` | `Pending` → `Paid` | ✅ e2e 2026-08-18, simulated funding |
| Crypto / stablecoin | async, minutes | `processing` → `succeeded` | `Pending` → `Paid` | ✅ ADR-007, e2e |
| Boleto | async, days | `requires_action` → `succeeded` | `Pending` → `Paid` | ⚠️ order axis by code path; not run e2e |
| Blik | sync, 60 s window | `requires_action` (`blik_authorize`) → `succeeded` | `Pending` → `Paid` | ⚠️ ADR-006 covers `pi_first`; order axis not run e2e |
| ACH (`us_bank_account`) | async, days | `processing` → `succeeded` | `Pending` → `Paid` | ⚠️ inferred — no ACH-specific code exists yet |
| Redirect methods (iDEAL, Klarna, P24…) | mostly sync | `requires_action` (`redirect_to_url`) → `succeeded` | `Pending` → `Paid` | ⚠️ inferred from event shape |
| Wallets (Apple/Google Pay, Express) | sync | `succeeded` | **unset** — site's job | ⚠️ inferred; no per-wallet branching |
| Pix / voucher / QR rails | async | `requires_action` → `succeeded`/expiry | `Pending` → `Paid`/`Failed` | ⚠️ inferred; not configured today |

⚠️ = the reasoning is sound and the code path is shared, but it has **not** been run end-to-end. Do
not cite an inferred row as measured.

---

## What this deliberately does not do

- **No `BalanceDue`, no `CreditOwed`.** `OrderPaymentState` in `stripe-payment.type.ts` carries three
  members, and the narrowness is the contract: every member is derivable from a Stripe event with no
  merchant policy input. `BalanceDue` is indistinguishable from the unset state Rule 2 preserves.
- **Refunds and disputes do not touch the order.** They remain a Payment-transaction concern
  (`refunds-reversals.md`).
- **`orderState` is never written** — only `paymentState`. Order lifecycle (`Open`/`Complete`) and
  `shipmentState` stay entirely the merchant's.
- **The order is never created.** See ADR-009 and Rule 1.

## Open questions

1. **Refund → `CreditOwed`?** Does a partially refunded order stop being `Paid`? Raised and
   explicitly deferred on 2026-08-18 as a merchant business decision.
2. **Which transaction wins for the order?** With `Authorization` + `Charge` + `Refund` +
   `Chargeback` on one Payment, the "general" order state is a policy, not a derivation. Currently
   settled by mapping from the **event**, not by reducing transactions — see ADR-009.
3. **Bank transfer expiry.** Whether an unfunded transfer reliably produces a terminal event, and
   which one, is **not verified**. If it produces none, the order stays `Pending` indefinitely — an
   accepted characteristic today (ADR-007's stuck-Pending risk), not a handled case.
4. **The buyer still sees "Payment Failed."** Unrelated to this axis and unfixed — the enabler's
   `PaymentResult` is a closed union with no pending state (KI-027, queue item `-026`). This rule
   fixes the **record**, not the screen.
