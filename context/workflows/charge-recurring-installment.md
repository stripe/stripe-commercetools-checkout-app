# Charge a Recurring Installment

**Trigger:** `POST /operations/transactions` with `type: 'Recurring'`, from commercetools Recurring Orders.
**Modules involved:** processor (the resulting order is picked up by the order-subscriber on `OrderCreatedFromRecurringOrder`).
**Outcome:** an off-session PaymentIntent charged against the customer's saved method, a commercetools Payment keyed by the installment, and a 201 with `Completed`, `Pending` or `Failed`.

## Happy Path

1. OAuth2 + authority `manage_project` / `manage_checkout_transactions`; answers 201 — `processor/src/routes/operation.route.ts:116-136`
2. Type guard (`Recurring` only), UUID installment id (`checkoutTransactionItemId`), customer-bound cart — `processor/src/services/stripe-payment.service.ts:3048-3073`
3. Amount from the cart; a requested amount may only match currency and not exceed it, and the cart amount is what is charged — `processor/src/services/stripe-payment.service.ts:3076,3101-3119`
4. Look up a Payment by key = installment id; assert it belongs to the cart's customer; if it already carries a resolved outcome, return it without charging — `processor/src/services/stripe-payment.service.ts:3146-3157,3456-3483,3522-3526`
5. Resolve the saved method strictly from commercetools (`paymentMethod.id` or `paymentMethodId`, scoped to the customer) and assert Stripe ownership — `processor/src/services/stripe-payment.service.ts:3159-3160,3539-3584`
6. Reuse a stuck `Authorization/Initial` payment (linking it to the cart if needed), or create one with `key` and `checkoutTransactionItemId` = installment id and add it to the cart; on `DuplicateField` resolve the concurrent winner — `processor/src/services/stripe-payment.service.ts:3162-3168,3183-3281`
7. `paymentIntents.create` off-session, `confirm: true`, `capture_method: automatic`, no redirects, metadata `ct_payment_id` / `cart_id` / `installment_id`, idempotency key `charge-{installment}` — `processor/src/services/stripe-payment.service.ts:3296-3317,3594-3618`
8. Map the status and book: `succeeded` → `Charge/Success` (deduped); `processing` → `Authorization/Pending`; anything else → `Authorization/Failure` and `Failed` — `processor/src/services/stripe-payment.service.ts:3318-3354,3390-3448,3626-3637`

## Error Paths

| Condition | Behavior | File |
| --- | --- | --- |
| Wrong type, bad installment id, anonymous cart, currency mismatch, amount above the cart, non-positive amount | `ErrorInvalidOperation` → 4xx | `processor/src/services/stripe-payment.service.ts:3050-3073,3106-3117` |
| Payment found by key belongs to another customer | `ErrorInvalidOperation` | `processor/src/services/stripe-payment.service.ts:3522-3526` |
| Saved-method id missing | `ErrorRequiredField('paymentMethodId')` | `processor/src/services/stripe-payment.service.ts:3550-3556` |
| Saved method has no token, customer not found, no Stripe customer, or method owned by another Stripe customer | `ErrorInvalidOperation` | `processor/src/services/stripe-payment.service.ts:3563-3581` |
| Concurrent trigger lost the create race | returns the winner's outcome, or `Pending` referencing the winner; never a second charge | `processor/src/services/stripe-payment.service.ts:3237-3248,3267-3281` |
| Card declined (incl. `authentication_required`) | `Authorization/Failure`; 201 `Failed` with the decline code | `processor/src/services/stripe-payment.service.ts:3355-3378,3642-3650` |
| Other Stripe / network / CT error | wrapped and re-thrown (not masked as 201) | `processor/src/services/stripe-payment.service.ts:3379-3380` |

## Notes

- Rules: `business-rules/recurring-charges.md` (Rules 1–10, e.g. Rule 4 "The amount charged is always the cart amount", Rule 5 "The Stripe idempotency key is the installment, never caller-supplied", Rule 6 "An installment already resolved is returned, not charged; a stuck one is retried").
