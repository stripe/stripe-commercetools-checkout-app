# ADR-007: Async Settlement — Model `payment_intent.processing` as a Pending Authorization

**Status:** Proposed (draft — pending human review/acceptance)
**Date:** 2026-07-20

> Draft generated from the committed implementation (`feat(checkout): support async settlement for crypto/stablecoin payments`) and the session's E2E + security review. Sections marked `[HUMAN REVIEW]` need human judgment before this ADR is accepted.

## Context

Asynchronous / redirect payment methods — crypto/stablecoin (USDC) today, ACH and bank transfers next — confirm a PaymentIntent into a `processing` status; settlement lands later, out of band. Card payments settle synchronously (`succeeded` / `requires_capture`).

Before this change, nothing in the connector modeled `processing`:

- The event→transaction converter had no case for `payment_intent.processing` and threw `Unsupported event`, which was swallowed (KI-001).
- `payment_intent.processing` was not in the webhook `enabled_events`.
- The synchronous confirm gate `updatePaymentIntentStripeSuccessful()` accepted only `succeeded` / `requires_capture` and **actively rejected** any other status — a `processing` PI surfaced a false checkout error to the shopper on a payment that was settling normally.

This is the cross-cutting "async-settlement gate" shared by three backlog items (crypto, ACH, bank transfers). The requirement: support crypto/stablecoin end-to-end, reflect the in-flight state in commercetools, never fulfill before settlement, and leave the traditional (card) flow unchanged.

## Decision

Model an in-flight `processing` PaymentIntent as a CT `Authorization` transaction in the `Pending` state, resolved to `Success` on settlement. Concretely:

1. **Converter** (`stripeEventConverter.ts`): `payment_intent.processing` → a single `Authorization/Pending` transaction (amount from `data.amount`, since `amount_received` is `0` while processing); `payment_intent.requires_action` → no-op (`[]`).
2. **Webhook** (`actions.ts`, `stripe-payment.route.ts`, `stripe-payment.service.ts`): subscribe `payment_intent.processing`; route it to `processStripeEvent()`; dedup with `hasTransactionInState()` before writing; scope the error-swallow so `processing` **rethrows** on failure (Stripe retries) while other events keep the existing log-and-return.
3. **Settlement** (`stripe-payment.service.ts`): on `payment_intent.succeeded`, transition the pending Authorization to `Success` (best-effort). The CT **order is created only on `succeeded`**, never during `processing`.
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
- `[HUMAN REVIEW]` Long mainnet `processing` windows (minutes, vs seconds on testnet) are untested at scale — confirm the pending state and its resolution behave under real settlement latency.
- `[HUMAN REVIEW]` Stuck-Pending scenario if `succeeded`/`payment_failed`/`canceled` never arrives (e.g. dropped webhook): there is no automated reconciliation. Decide whether a reconciliation/timeout mechanism is needed before enabling in production.
- `[HUMAN REVIEW]` Confirm whether this pattern should be ported to `ct-connect-stripe-composable`'s enabler, whose confirm path may signal success unconditionally.
