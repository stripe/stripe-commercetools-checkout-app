# ADR-007: Async Settlement — Model `payment_intent.processing` as a Pending Authorization

**Status:** Accepted
**Date:** 2026-07-20 · **Accepted:** 2026-08-13 · **Amended:** 2026-08-13 (bank transfer, SB3-207)

> Accepted 2026-08-13, after the pattern it describes was exercised by a second payment method. Two of the three `[HUMAN REVIEW]` risks below remain open and are marked as such — acceptance records that the *decision* is settled, not that every risk is closed.
>
> **Amendment (2026-08-13, SB3-207).** Decision item 1 originally fixed `payment_intent.requires_action` as a no-op returning `[]`. Bank transfers reversed that: the event now writes an `Authorization/Pending`, gated at the route. The original text is not preserved inline — read this ADR as amended and see the git history for the pre-amendment wording. What did NOT change is the shape of the decision: an in-flight payment is still modelled as `Authorization/Pending` and still resolves to `Success` on settlement. Bank transfer reached the same model through a different event, which is the outcome item 3's "method-agnostic" claim predicted.

## Context

Asynchronous / redirect payment methods — crypto/stablecoin (USDC) today, ACH and bank transfers next — confirm a PaymentIntent into a `processing` status; settlement lands later, out of band. Card payments settle synchronously (`succeeded` / `requires_capture`).

Before this change, nothing in the connector modeled `processing`:

- The event→transaction converter had no case for `payment_intent.processing` and threw `Unsupported event`, which was swallowed (KI-001).
- `payment_intent.processing` was not in the webhook `enabled_events`.
- The synchronous confirm gate `updatePaymentIntentStripeSuccessful()` accepted only `succeeded` / `requires_capture` and **actively rejected** any other status — a `processing` PI surfaced a false checkout error to the shopper on a payment that was settling normally.

This is the cross-cutting "async-settlement gate" shared by three backlog items (crypto, ACH, bank transfers). The requirement: support crypto/stablecoin end-to-end, reflect the in-flight state in commercetools, never fulfill before settlement, and leave the traditional (card) flow unchanged.

## Decision

Model an in-flight `processing` PaymentIntent as a CT `Authorization` transaction in the `Pending` state, resolved to `Success` on settlement. Concretely:

1. **Converter** (`stripeEventConverter.ts`): `payment_intent.processing` → a single `Authorization/Pending` transaction (amount from `data.amount`, since `amount_received` is `0` while processing).

   **Amended 2026-08-13 (SB3-207):** `payment_intent.requires_action` is no longer a no-op. It produces the same single `Authorization/Pending`, for `data.amount` and for the same reason — `amount_received` is `0` until the wire lands, so reusing the settled-amount helper would book a zero-cent authorization. `payment_intent.partially_funded` takes over the no-op role (`[]`), because a bank transfer funded in instalments must not book a second authorization or recognise revenue that sits in the customer's cash balance rather than on the platform balance.

   The converter's `requires_action` case is **unconditional**, and the narrowing lives one layer up — see item 2. That split matters: card 3DS and Boleto emit the same event, and a converter that also tried to discriminate would be a second gate that can drift from the first.

2. **Webhook** (`actions.ts`, `stripe-payment.route.ts`, `stripe-payment.service.ts`): subscribe `payment_intent.processing`; route it to `processStripeEvent()`; dedup with `hasTransactionInState()` before writing; scope the error-swallow so `processing` **rethrows** on failure (Stripe retries) while other events keep the existing log-and-return.

   **Amended 2026-08-13 (SB3-207):** the scoped rethrow and the dedup guard are now driven by an `ASYNC_PENDING_EVENTS` allowlist holding `processing` and `requires_action`, so widening the set is a one-line change rather than an edit in two places that can disagree. `partially_funded` is deliberately excluded from that allowlist: it writes no transaction, so a lost event costs an audit line rather than correctness, and rethrowing would cause a retry storm on an event that fires once per instalment. It persists its interface interaction instead, via a second allowlist (`ZERO_TRANSACTION_PERSIST_EVENTS`).

   **The route is the gate.** `requires_action` reaches `processStripeEvent()` only when `isBankTransferNextAction()` holds — `next_action.type === 'display_bank_transfer_instructions'` with the instructions object present, strict equality, failing closed. Card 3DS (`use_stripe_sdk`) and Boleto (`boleto_display_details`) emit the identical event and keep a log-only path. Without that predicate every 3DS payment would get an `Authorization/Pending` written to commercetools, which is the most severe regression this feature can cause; it is held by release-gate tests in both directions, including the mirror assertion that a bank transfer *is* routed.
3. **Settlement** (`stripe-payment.service.ts`): on `payment_intent.succeeded`, transition the pending Authorization to `Success` (best-effort). ~~The CT **order is created only on `succeeded`**, never during `processing`.~~

   **Amended 2026-08-18 (SB3-207 task 028) — the struck sentence was false for this connector, and superseded by ADR-009.** It describes the **composable** connector, which creates orders itself. In **checkout**, post-`0ab8d2c`, this connector does not create orders at all: commercetools Checkout creates them at completion, without waiting for settlement. Measured with timestamps on 2026-08-18 on the bank-transfer rail — the order was created at `02:41:19.883`, in the same second as `payment_intent.requires_action` and **two minutes before** `payment_intent.succeeded`, with `paymentState: null`.

   The claim was not merely imprecise, it inverted the safety argument: the "Alternatives Considered" row below rejects creating the order on `processing` to avoid premature fulfillment, on the assumption that we control the timing. We do not. commercetools Checkout already creates the order before settlement, so the exposure that row exists to prevent is **live today** and cannot be closed from this connector. What ADR-009 adds is `paymentState`, so an unsettled order is at least *visibly* `Pending` rather than indistinguishable from an abandoned one.
4. **Synchronous gate** (`updatePaymentIntentStripeSuccessful()`): now returns a `PaymentModificationStatus` outcome — `processing` writes `Authorization/Pending` only and returns `PENDING` (route → HTTP 202); `succeeded`/`requires_capture` → `APPROVED` (HTTP 200). The three validations (retrieve PI + `metadata.ct_payment_id` match + amount/currency match) are **unchanged**; invalid/mismatch still throws.
5. **Enabler** (`dropin-embedded.ts`): `confirmPaymentIntent()` branches on the response `outcome` — a `pending` result does **not** signal success, preventing premature fulfillment.

## Alternatives Considered

| Alternative | Why discarded |
|---|---|
| Model `processing` as `Charge/Pending` | Conflicts with the `Charge` written on `succeeded` (`updatePayment` appends); `Authorization/Pending` is the natural pre-settlement state and transitions cleanly to `Success`. |
| Create the CT order optimistically on `processing` | Premature fulfillment — funds are not settled; a later `payment_failed`/`canceled` would leave a fulfilled, unpaid order. Order is gated to `succeeded` only. |
| Keep the gate rejecting `processing`, rely on the webhook alone | Non-redirect async methods (ACH/bank transfer) confirm synchronously through the gate; rejecting there surfaces a false error to the shopper. The gate must return `PENDING`. |
| Un-scoped no-swallow (rethrow on all webhook errors) | Would change the card regression behavior documented in KI-001. The rethrow is scoped to `payment_intent.processing` only. |

## Redirect vs non-redirect (validated E2E)

Crypto is **redirect-based**: the buyer leaves to the Stripe-hosted wallet page and the entire lifecycle (`processing` → `succeeded`) is **webhook-driven** — the synchronous gate is never hit. Verified live (PIs `pi_3TvKup…` and `pi_3TvLpT…` never called `/confirmPayments`; the full `Authorization: Initial → Pending → Success` + `Charge/Success` was written from the webhook path).

For **non-redirect** async methods (ACH, bank transfers), the gate WILL run and return `PENDING` — so the gate + enabler path (decision items 4–5) is defensive/edge-case for crypto but load-bearing for those future methods.

## Idempotency / TOCTOU

The `Authorization/Pending` write can occur from both the gate and the `payment_intent.processing` webhook. The `hasTransactionInState()` dedup is read-then-write (not atomic), so concurrent writes race on CT optimistic locking (409 `ConcurrentModification`), recovered by retry + the dedup re-check on retry — no double charge or double order results (observed live and recovered). The race is fully closed only by a deterministic idempotency key derived from the CT payment ID (out of scope here; see KI-007 / KI-026).

## Consequences

**Positive:**
- Crypto/stablecoin supported end-to-end in checkout; the in-flight state is visible in CT as `Authorization/Pending`.
- The `processing` plumbing is method-agnostic — directly reusable by ACH and bank transfers.
- Card / synchronous regression intact (gate still returns `APPROVED`/200 for `succeeded`).

**Negative:**
- The enabler signals a `pending` outcome as `onComplete({ isSuccess: false })`, which the host may render as a decline (KI-027). A dedicated processing result state on `PaymentResult` is a follow-up.
- Under the gate↔webhook race, a transient duplicate `Pending` or a spurious 400 to the shopper is possible until a deterministic idempotency key lands.

**Risks:**
- `[HUMAN REVIEW]` Long mainnet `processing` windows (minutes, vs seconds on testnet) are untested at scale — confirm the pending state and its resolution behave under real settlement latency. **Still open.** Bank transfer does not close this: it stretches the window from minutes to days, which makes the question larger rather than answered.

- ~~`[HUMAN REVIEW]` Stuck-Pending scenario~~ — **CLOSED 2026-08-13, and closed by evidence rather than by assertion.** The risk was written speculatively ("e.g. a dropped webhook"). Bank transfer supplies the concrete instance: a shopper who receives wire instructions and simply never sends the money leaves an `Authorization/Pending` that no terminal event will ever resolve. This is not an edge case on that rail — it is ordinary abandonment, and it is expected to be the most common non-happy path. What is confirmed: **there is no automated reconciliation, and none is being added here.** The Pending is durable and the cart is not frozen (see below). Operators must expect stale Pending authorizations on bank transfer and reconcile them out of band. Recording this as a known, accepted characteristic is what closes the risk; building the reconciliation is a separate decision that has not been taken.

- `[HUMAN REVIEW]` Confirm whether this pattern should be ported to `ct-connect-stripe-composable`'s enabler, whose confirm path may signal success unconditionally. **Still open.**

- **New (2026-08-13, SB3-207) — the cart stays mutable for the whole funding window.** The sibling composable connector freezes the cart at the commitment point; checkout does not, because `connect-payments-sdk` exposes no freeze capability and hand-rolling one is new work rather than a port. Two commercetools behaviours, verified 2026-08-13, mean nothing downstream compensates: commercetools does **not** refuse to complete an order whose payment does not cover the cart — it assigns that check to the integrator — and it does **not** serialise concurrent checkout attempts on one cart; its own documentation states that two tabs produce two payments, with refund as the remedy. Neither assumption may be relied on by any handler. On a card rail the exposure is seconds; on bank transfer it is days.
