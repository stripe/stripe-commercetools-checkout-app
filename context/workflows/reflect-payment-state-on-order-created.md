# Reflect the Payment State When an Order Is Created

**Trigger:** commercetools publishes `OrderCreated` or `OrderCreatedFromRecurringOrder`; Pub/Sub pushes it to `POST /orderSubscriber/`.
**Modules involved:** order-subscriber (reads data the processor wrote).
**Outcome:** `Order.paymentState` set to `Paid` or `Pending` on an order paid through this connector whose state was unset; otherwise nothing.

## Happy Path

1. Decode the base64 body and classify (creation test message, message type, order id) — `order-subscriber/src/controllers/order.controller.ts:20-47`; `order-subscriber/src/validators/message.validator.ts:20-47`
2. Fresh `GET` of the order with `paymentInfo.payments[*]` expanded — never the payload's stale snapshot — `order-subscriber/src/clients/order.client.ts:38-46`
3. Guard: state must be unset — `order-subscriber/src/clients/order.client.ts:58-65`
4. Keep the connector's payments by `paymentInterface` — `order-subscriber/src/clients/order.client.ts:67-74,136-139`
5. Resolve the target: if any of **our** payments has `Charge/Success`, `Paid` only when all the order's `Charge/Success` (any connector, order currency) cover `taxedPrice.totalGross ?? totalPrice`, else nothing; otherwise `Pending` if any of ours has `Authorization/Pending` — `order-subscriber/src/clients/order.client.ts:76-85`; `order-subscriber/src/guard.ts:189-206`
6. `changePaymentState` with the read version — `order-subscriber/src/clients/order.client.ts:170-205`
7. 204 — `order-subscriber/src/controllers/order.controller.ts:49-52`

## Error Paths

| Condition | Behavior | File |
| --- | --- | --- |
| No data / undecodable / ignored type | 204 (a retry cannot help) | `order-subscriber/src/controllers/order.controller.ts:24-47` |
| Already set, or not ours | 204, logged with reason | `order-subscriber/src/clients/order.client.ts:58-74` |
| Settled charges do not cover the gross | Nothing written; 204, warn for manual review | `order-subscriber/src/clients/order.client.ts:95-105` |
| Authorization without a charge (manual capture) | 204, info | `order-subscriber/src/clients/order.client.ts:106-113` |
| 409 on write | re-resolve (guard and target) from a fresh read and post once more | `order-subscriber/src/clients/order.client.ts:174-186` |
| Any other write failure | 500 → Pub/Sub redelivers | `order-subscriber/src/controllers/order.controller.ts:53-64` |

## Notes

- Exists because for a card the order is created after the money settles, so the webhook path has no order to write to (`order-subscriber/src/guard.ts:135-141`).
- Rules: `business-rules/order-payment-state.md` Rule 6 "The subscriber records what is true at `OrderCreated`, onto an empty field only" (it also holds the fresh read, `Paid` outranking `Pending`, and an authorization without a charge leaving the order unset), Rule 7 "The subscriber decides involvement from this connector's payments only", Rule 9 "`Paid` is written only when settled money covers the order's gross total", and `business-rules/order-subscription.md` Rule 4 "Only order-creation messages are acted on", Rule 5 "Ignored and undecodable messages are acknowledged; failed writes are retried".
