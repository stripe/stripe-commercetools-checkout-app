# ADR-002 — Server-Side Payment Intent Confirmation for 3DS Support

**Status:** Accepted  
**Date:** 2024

## Context

Stripe Payment Intents can be confirmed client-side (`stripe.confirmPayment()`) or server-side (`paymentIntents.confirm()` via API). The connector needs to support 3DS (Strong Customer Authentication) without relying on the browser completing the flow before the order is created in commercetools.

## Decision

The processor is the authority for transitioning the CT Payment to `AUTHORIZED`. The actual Stripe confirmation step is still triggered client-side by `stripe.confirmPayment()` (the Payment Element does the network call to Stripe), but the connector then re-validates the PI server-side before updating CT. Concretely:

1. Client collects payment method via Payment Element
2. Client calls `stripe.confirmPayment()` — Stripe returns `succeeded` / `requires_capture` / `requires_action`
3. Client calls `POST /confirmPayments/:id` on the processor with the PI id
4. Processor calls `stripe.paymentIntents.retrieve(piId)` and runs a 4-point check (PI retrievable, status in {`succeeded`, `requires_capture`}, `metadata.ct_payment_id` matches `paymentReference`, amount/currency match the CT `amountPlanned`)
5. Processor calls `ctPaymentService.updatePayment` to mark the CT payment as `AUTHORIZED`

`MERCHANT_RETURN_URL` is exposed to the client as `merchantReturnUrl` via `/config-element` and consumed by `stripe.confirmPayment({ return_url })` in the browser. The processor never sets `return_url` on the PaymentIntent itself.

The processor does **not** call `stripe.paymentIntents.confirm()`; confirmation happens in the browser via Stripe.js. The "server-side" aspect is the validation and CT state transition.

## Consequences

- 3DS redirects are supported: `stripe.confirmPayment({ return_url: merchantReturnUrl })` is called browser-side; Stripe sends the customer back to `MERCHANT_RETURN_URL` after authentication
- The processor acts as the authority for payment state — client cannot authorize payments without server validation
- The 4-point validation prevents replay attacks (a client cannot authorize a different amount by swapping IDs)
- Requires `MERCHANT_RETURN_URL` to be configured for redirect-based payment methods (iDEAL, Bancontact, etc.)

## Alternatives Considered

| Option | Reason rejected |
|---|---|
| Client-side `stripe.confirmPayment()` | State sync between Stripe and CT relies on the browser completing the flow; unreliable on page close or network drop |
| Webhook-only confirmation | Too slow for synchronous checkout UX; introduces race conditions on the order page |
