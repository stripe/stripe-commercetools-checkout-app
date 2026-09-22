# ADR-010: Recurring off-session charge anchors idempotency solely on checkoutTransactionItemId

**Status:** Accepted (ratified 2026-09-21). The idempotency-anchor Decision below (sole anchor = `checkoutTransactionItemId`, no `??` fallback) stands and is validated live. Its dedup MECHANISM as described in Context (`findPaymentsByInterfaceId` on `interfaceId = installmentKey`) is superseded by ADR-011 — the dedup is now keyed on the unique `Payment.key`, and `interfaceId` now holds the real PaymentIntent id. The anchor VALUE is unchanged.
**Date:** 2026-09-08

## Context

`POST /operations/transactions` (server-to-server, off-session recurring charge) derives BOTH the Stripe
idempotency key (`charge-{installmentKey}`) and the commercetools payment dedupe (`findPaymentsByInterfaceId`
on `interfaceId = installmentKey`) from a single `installmentKey`.

The initial implementation set `installmentKey = draft.futureOrderNumber ?? draft.checkoutTransactionItemId`.
A Phase 3 security review found this can shift the anchor across retries: an early attempt runs before an order
number exists (anchor = `checkoutTransactionItemId`), a later retry runs after `futureOrderNumber` is assigned
(anchor = `futureOrderNumber`). The two attempts then key on different values, so neither the Stripe idempotency
key nor the CT dedupe catches the duplicate → the customer is charged twice off-session. This violates hub
Global Coding Rule 4 (idempotency keys derived from a *stable* single platform-entity identity).

The reference implementations (`connect-payment-integration-template`, `connect-payment-integration-adyen`)
make `checkoutTransactionItemId` a REQUIRED uuid and anchor solely on it; `futureOrderNumber` is a separate
optional field, never an idempotency anchor.

## Decision

`checkoutTransactionItemId` is a REQUIRED uuid on the transaction DTO and is the SOLE idempotency anchor for a
recurring installment. The `?? futureOrderNumber` fallback is removed. A defense-in-depth service-level
fail-closed check is retained so the guarantee holds even if the DTO changes. `futureOrderNumber` remains an
optional, non-anchoring field.

## Alternatives Considered

| Alternative | Why discarded |
| --- | --- |
| Keep `futureOrderNumber ?? checkoutTransactionItemId` | Anchor can shift across retries → off-session double charge |
| Anchor on `futureOrderNumber` only | Not always present at first cycle; not the reference contract |
| Require BOTH and derive from a composite | More surface, diverges from reference; a single stable uuid suffices |

## Consequences

**Positive:** Deterministic, stable anchor for the installment lifetime; Stripe idempotency + CT dedupe always
agree; matches the reference DTO contract; resolves the HIGH double-charge finding.
**Negative:** Callers MUST send `checkoutTransactionItemId` (a uuid) — a stricter contract than before.
**Risks:** If the platform's recurring-payment job does not send `checkoutTransactionItemId`, the request now
fails closed (400) rather than silently anchoring on something else. Confirm the platform always forwards it
(tracked open item: seal the real cycle payload).

## Related

- Session: `workspace/2026-09-08-recurring-transactions-completion/`
- ADR-009 (order-payment-state reflection), business-rules/order-payment-state.md Rule 4
- Reference: `connect-payment-integration-template/processor/src/dtos/operations/transaction.dto.ts`
