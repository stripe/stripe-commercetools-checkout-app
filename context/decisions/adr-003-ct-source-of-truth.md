# ADR-003 — CT Payment Object as Source of Truth for Transaction State

**Status:** Accepted  
**Date:** 2024

## Context

Payment state lives in two systems simultaneously: Stripe (PaymentIntent status, charge events) and commercetools (Payment object with Transactions). A clear ownership rule is needed to avoid split-brain scenarios.

## Decision

The **CT Payment object is the source of truth for transaction state**. Stripe is the source of truth for money movement (actual charges, refunds, and amounts).

Concretely:
- CT Transaction `state` drives the connector's business logic (what operations are allowed)
- Stripe events update CT — never the reverse
- The connector never reads Stripe to determine "what happened"; it reads CT
- Stripe `PaymentIntent` ID is stored as a CT Payment custom field and used as the lookup key

## Consequences

- Webhook handlers (`POST /stripe/webhooks`) are responsible for keeping CT in sync with Stripe events
- The connector uses CT's **optimistic locking** (`payment.version`) on every update to prevent concurrent writes
- If a webhook fails and CT is out of sync, the CT payment is the stale record — not Stripe
- Idempotency: webhook handlers must be safe to re-process (same Stripe event processed twice must produce the same CT state)

## Alternatives Considered

| Option | Reason rejected |
|---|---|
| Stripe as source of truth | Requires polling or webhooks to drive CT state; CT becomes eventually consistent without a clear single owner |
| Dual source of truth | Leads to split-brain in partial failure scenarios (webhook delayed, CT update fails) |
