# ADR-004 — Multi-Capture as Opt-In Feature

**Status:** Accepted  
**Date:** 2024

## Context

Standard payment capture is all-or-nothing: once captured, a PaymentIntent is closed. Some merchants need partial captures (e.g., split-shipment fulfillment where items ship at different times and amounts are captured per shipment).

Stripe supports partial capture natively, but it adds complexity to refund tracking and balance transaction reconciliation.

## Decision

Multi-capture (partial captures + multiple refunds on a single PI) is **opt-in** via the environment variable `STRIPE_ENABLE_MULTI_OPERATIONS=true`. When disabled (default), the connector enforces single full capture.

When enabled:
- Multiple `POST /payment-intents/:id` capture calls are allowed on the same PI
- Partial capture amounts are reconciled by calling `balanceTransactions.list()` on `charge.updated` events
- Refunds use `refunds.list()` for tracking (not balance transactions)
- CT Transaction history reflects each partial capture as a separate `CHARGE` transaction

## Consequences

- Default behavior (disabled) is simpler and less error-prone for most merchants
- Enabling multi-capture requires the merchant to configure Stripe's `capture_method: manual` on PaymentIntents
- Partial refunds require balance transaction lookups, which adds one extra Stripe API call per refund operation
- CT's transaction model needs to support multiple `CHARGE` transactions on a single Payment object

## Alternatives Considered

| Option | Reason rejected |
|---|---|
| Always-on multi-capture | Increases complexity for all merchants; most don't need it |
| Separate connector for multi-capture | Duplicates codebase; a feature flag is sufficient |
