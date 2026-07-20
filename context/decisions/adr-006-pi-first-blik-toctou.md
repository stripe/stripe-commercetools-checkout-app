# ADR-006: PI-First Flow for Blik and TOCTOU Mitigation

**Status:** Accepted
**Date:** 2026-06-14

## Context

Stripe's deferred Elements flow creates a PaymentIntent at submit time (via `GET /payments`). For
payment methods such as Blik that must bind to a specific PaymentIntent before the payment element
renders, this is incompatible: `stripe.elements({ mode })` cannot accept Blik without a
`clientSecret` already present.

The deferred flow also carries a TOCTOU (Time-Of-Check / Time-Of-Use) window: if the cart amount
or currency changes between the time Elements renders and the time `submit()` calls `GET /payments`,
the newly created PaymentIntent reflects the updated cart — not the one the user reviewed. While
rare, this is a correctness gap.

The existing `GET /payments` handler (`createPaymentIntentStripe`) uses `crypto.randomUUID()` as
the idempotency key. There is no session-scoped deduplication: every HTTP call creates a new
PaymentIntent and a new CT payment object.

## Decision

Introduce a `pi_first` mode controlled by the `STRIPE_PAYMENT_FLOW` environment variable
(values: `deferred` | `pi_first`, default: `deferred`). When `pi_first` is active:

1. The processor returns `flowType: 'pi_first'` in the `GET /config-element/payment` response and
   suppresses `setupFutureUsage` from both the config-element response and the PaymentIntent
   creation parameters.
2. The enabler's `_Setup()` calls `GET /payments` exactly once, caches the full response
   (`sClientSecret`, `paymentReference`, `merchantReturnUrl`, `cartId`, `billingAddress`) in
   `baseOptions.piFirstResponse`, and passes `clientSecret` to `stripe.elements({ clientSecret })`.
3. `submit()` reads all five fields from `baseOptions.piFirstResponse`. It **never** calls
   `getPayment()` — doing so would invoke `createPaymentIntentStripe` a second time, creating a
   second PI and leaving the first as an orphan.

The deferred flow is unchanged. No existing merchant deployments are affected unless
`STRIPE_PAYMENT_FLOW=pi_first` is explicitly set.

## Alternatives Considered

| Alternative | Why discarded |
|---|---|
| Call `GET /payments` at `submit()` time in pi_first mode and discard the `_Setup()` clientSecret | Defeats the purpose — pi_first requires Elements to be initialized with `clientSecret` before rendering |
| Implement a deterministic idempotency key for `GET /payments` | Out of scope; tracked as a known gap in `context/known-issues.md` and `CLAUDE.md` conventions |
| Separate pi_first behind a feature flag in the enabler only | Cannot work — the processor must suppress `setupFutureUsage` at PI creation time; both sides must change together |

## TOCTOU Window

In deferred mode, the cart amount is read at submit time. A cart mutation between render and submit
produces a PaymentIntent for the new amount — the user authorized a different total. pi_first
closes this window: the amount is fixed when `_Setup()` runs (at component mount), before the user
interacts with the payment element.

## Orphan-PI Risk

When `_Setup()` runs (PI created) but `submit()` is never called (user abandons), the PI sits
uncaptured. Stripe auto-cancels it after `expires_at` (default 1 hour). No manual cleanup is
required. A spike in `payment_intent.canceled` webhook events with
`cancellation_reason: automatic` indicates abnormal abandonment rates.

## Non-Deterministic Idempotency Amplification

`createPaymentIntentStripe()` uses `crypto.randomUUID()` as its idempotency key (pre-existing gap).
In pi_first mode, each component mount calls `_Setup()` → `GET /payments` → new PI. A rapid
remount sequence (React Strict Mode double-invoke, SPA back/forward navigation) produces multiple
orphaned PIs for the same cart. Teams using pi_first should monitor PI creation rate against
order volume as an operational signal.

## `requires_action` / Blik Authorization Flow — Storefront Contract

After `elements.submit()`, `confirmPayment()` is called on the Stripe SDK. For Blik, the resulting
`paymentIntent.status` will be `'requires_action'` with `next_action.type === 'blik_authorize'`.
The connector propagates this as an error to the storefront via `onError`
(see `dropin-embedded.ts` — `confirmStripePayment`). This is the correct and expected behavior;
no connector code change is needed.

Storefront implementers must:

1. Listen for `onError` events where `error.type === 'requires_action'`
2. Check `error.next_action.type === 'blik_authorize'`
3. Display an "Authorize in your banking app" UX — the customer has 60 seconds to approve the
   payment in their bank's mobile app
4. After 60 seconds, if not authorized, the PI transitions to `canceled`
   (`cancellation_reason: 'automatic'`); show a retry prompt
5. On success, the PI transitions to `succeeded` via webhook — listen for the order confirmation
   event from the commerce platform (do not poll Stripe directly)

Failure to handle `requires_action` leaves Blik customers seeing a generic error with no guidance.

## Consequences

**Positive:**
- Enables Blik (and any other PI-bound payment method) without changes to the webhook or capture
  flows
- Closes the TOCTOU window for the pi_first path
- Zero impact on deferred-mode deployments — env var defaults to `deferred`

**Negative:**
- Orphan PIs are created on component mount; cannot be avoided without a deterministic idempotency
  key
- `setupFutureUsage` / saved card support is mutually exclusive with pi_first; merchants needing
  both must use deferred mode

**Risks:**
- React Strict Mode or aggressive SPA remounting can produce multiple PIs per session; monitor
  PI creation rate
- If a future change re-introduces a `getPayment()` call inside `submit()` on the pi_first path,
  it will create a second PI silently — the `piFirstResponse` guard (`throw new Error(...)`) is the
  primary protection against this regression
