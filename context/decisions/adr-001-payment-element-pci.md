# ADR-001 — Stripe Payment Element for PCI Compliance Reduction

**Status:** Accepted  
**Date:** 2024

## Context

The connector must handle card payments without bringing the merchant's server into PCI DSS scope for cardholder data. Direct card collection (raw card numbers) would require SAQ D compliance — the most demanding level.

## Decision

Use **Stripe Payment Element** as the sole card collection mechanism. The Payment Element is an iframe-based component hosted by Stripe; card data never touches the merchant's server or the connector's processor.

## Consequences

- Merchant qualifies for **SAQ A** (lowest PCI scope) — iframe-based card collection
- No card numbers, CVCs, or raw payment data pass through the processor
- The connector stores only `PaymentMethod` IDs (tokenized references)
- UI customization is limited to Stripe's Appearance API — no full HTML control over card fields
- 3DS authentication is handled within the Payment Element iframe, not by the connector

## Alternatives Considered

| Option | Reason rejected |
|---|---|
| Stripe.js `CardElement` (legacy) | Deprecated; no support for wallets, Link, or bank methods in a single UI |
| Custom card form + `stripe.createPaymentMethod()` | Increases PCI scope; requires explicit tokenization handling |
| Hosted Payment Page (Stripe Checkout) | Loses full control of the checkout UX; redirects away from merchant storefront |
