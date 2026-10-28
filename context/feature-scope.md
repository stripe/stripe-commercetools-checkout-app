# Feature Scope — ct-connect-stripe-checkout

What this connector does, traced to the entry point that does it, and what it does not. Answer "not in
scope for this connector" from the **Out of Scope** section rather than from general Stripe knowledge.

## At a glance

| # | Section | What decides whether to read it |
| --- | --- | --- |
| 1 | Drop-in checkout with the Payment Element | `GET /payments` → Stripe PaymentIntent + CT Payment; confirm gate; guest and saved-customer paths |
| 2 | Express Checkout | Apple Pay / Google Pay buttons, shipping callbacks, with or without a session |
| 3 | Payment methods and settlement | Cards and 3DS, EU bank transfer, async (crypto, ACH) — what each writes |
| 4 | Payment operations | Capture, cancel, refund, reverse from the platform; multi-operations |
| 5 | Recurring off-session charges | `POST /operations/transactions` for commercetools recurring orders |
| 6 | Webhook-driven Payment updates | What each of the 12 registered events writes |
| 7 | `Order.paymentState` | Who writes `Paid`, `Pending`, `Failed`, and when |
| 8 | Tax | One external calculation reference forwarded |
| 9 | Configuration-Driven Behavior | Settings that change behaviour at runtime |
| 10 | Out of Scope | What the connector does not do |

---

## 1. Drop-in checkout with the Payment Element

| Capability | How | File |
| --- | --- | --- |
| Create the payment | `GET /payments` creates a Stripe PaymentIntent and a CT Payment with an `Authorization/Initial`, adds it to the cart, stamps `metadata.ct_payment_id`, returns `{sClientSecret, paymentReference, merchantReturnUrl, cartId, billingAddress?}` | `processor/src/routes/stripe-payment.route.ts:74`; `processor/src/services/stripe-payment.service.ts:750-961` |
| Reuse instead of duplicate | A repeated `GET /payments` reuses the cart's active payment when amount, currency and PaymentIntent configuration match; a PaymentIntent already in progress answers an error instead of a second charge | `processor/src/services/stripe-payment.service.ts:1203-1352`, `:1054` (`business-rules/payment-lifecycle.md` Rules 13-14) |
| Confirm gate | `POST /confirmPayments/:id` checks that the cart references the payment, the PaymentIntent status, `metadata.ct_payment_id`, `metadata.cart_id`, amount and currency; answers 200 `approved`, 202 `pending` or 400 `rejected` | `processor/src/services/stripe-payment.service.ts:1547-1667`, `:1687-1737` (`business-rules/payment-lifecycle.md` Rule 2) |
| Guest checkout | `GET /customer/session` answers 204 when the cart has no customer; the Payment Element runs without customer options | `processor/src/services/stripe-payment.service.ts:628` |
| Saved payment methods | For a logged-in customer: Stripe customer resolved or created, ephemeral key and customer session returned; methods stored from webhooks | `processor/src/services/stripe-payment.service.ts:624-658`, `:2606-2660` (`business-rules/customer-session.md`) |
| Billing address | Collected per `STRIPE_COLLECT_BILLING_ADDRESS`; returned from `GET /payments` when not `'auto'` | `processor/src/services/stripe-payment.service.ts:1411-1412` |
| Element appearance and behaviour | `GET /config-element/payment` returns appearance, layout, capture method, `setup_future_usage`, element options and flow type | `processor/src/services/stripe-payment.service.ts:1861-1924` |
| Early PaymentIntent (`pi_first`) | Created during enabler setup, before the element mounts — for methods that need it (Blik) | `enabler/src/payment-enabler/payment-enabler-mock.ts:156-158` |
| Components | **Drop-in `embedded` only.** `createComponentBuilder` always throws | `enabler/src/payment-enabler/payment-enabler-mock.ts:194-230` |

## 2. Express Checkout

| Capability | How | File |
| --- | --- | --- |
| Express buttons before a session | No `sessionId`: `POST /express-config` (origin-checked when `ALLOWED_ORIGINS` is set), then Elements created when the component initialises; the session comes from the host's `onPayButtonClick` | `enabler/src/payment-enabler/payment-enabler-mock.ts:311-352`; `enabler/src/express/dropin-express.ts:182-200` |
| Express with a session | Customer-aware setup; `x-express-customer-session: true` binds the Stripe customer when one is known | `enabler/src/express/dropin-express.ts:590-602`; `processor/src/services/stripe-payment.service.ts:813` |
| Shipping | Address and rate changes call the host's callbacks, re-read totals from `GET /express-payment-data`, update the amount; the first rate is applied | `enabler/src/express/dropin-express.ts:284-347`; `processor/src/services/stripe-payment.service.ts:1789-1852` |
| No shipping on the PaymentIntent | Express never sends `shipping` | `processor/src/services/stripe-payment.service.ts:832` (`business-rules/payment-lifecycle.md` Rule 5) |
| Duplicate confirm guard | A second `confirm` while one is in flight, or after one succeeded, is ignored | `enabler/src/express/dropin-express.ts:412` |
| Outcome | Success reported to both completion callbacks | `enabler/src/express/dropin-express.ts:459-479`, `:539-582` |

## 3. Payment methods and settlement

Payment methods are surfaced by Stripe from the account settings, currency and country; the connector
has no per-method code except where listed.

| Method | Behaviour | File |
| --- | --- | --- |
| Cards, wallets | Synchronous; confirm gate books `Authorization/Success`; `payment_intent.succeeded` books `Charge/Success` | `processor/src/services/stripe-payment.service.ts:1658-1667`; `processor/src/services/converters/stripeEventConverter.ts` |
| 3DS / SCA | Resolved client-side by Stripe.js with `redirect: 'if_required'`; `requires_action` writes no transaction for a card, but drives the order to `Pending` | `enabler/src/dropin/dropin-embedded.ts:156-168`; `processor/src/routes/stripe-payment.route.ts:322-327` |
| EU bank transfer (`customer_balance`) | `requires_action` with bank-transfer instructions books `Authorization/Pending`; settlement later books `Charge/Success` and promotes the authorization. `euBankTransferCountry` pins the IBAN country (DE/FR/IE/NL) for EUR carts — it does not enable the rail | `processor/src/mappers/bank-transfer-mapper.ts:22`, `:66-79`; `business-rules/payment-behavior-rules.md` Rules 6-8 |
| Bank transfer instalments (`partially_funded`) | No transaction: a partial `Charge` would recognise money still in the cash balance, and a `Pending` would add nothing | `processor/src/services/stripe-payment.service.ts:2047-2056`; `processor/src/routes/stripe-payment.route.ts:324` |
| Async settlement (crypto, stablecoin, ACH-style) | `processing` books `Authorization/Pending` at `pi.amount`, deduped; confirm answers 202; finalised on `succeeded`. Requirements for crypto to appear are in `workflows/process-async-settlement.md` | `processor/src/services/stripe-payment.service.ts:1653`, `:1755-1779` |
| ACH direct debit (`us_bank_account`) | No dedicated code; works through the async-settlement, `requires_action` and `payment_failed` paths. The measured outcome per case is in `business-rules/order-payment-state.md` Rule 6 | — |

## 4. Payment operations

| Operation | How | File |
| --- | --- | --- |
| Capture (manual capture) | `capturePayment`; a partial capture needs multi-operations and is sent with `final_capture: false` | `processor/src/services/stripe-payment.service.ts:323-378` (`business-rules/multi-operations.md`) |
| Cancel | `cancelPayment` cancels the PaymentIntent | `:389` |
| Refund, full or partial | `refundPayment`, key `refund-{paymentId}-{amount}`; answers `RECEIVED` — the final state arrives by webhook | `:419-569` (`business-rules/refunds-reversals.md` Rules 3, 5) |
| Multiple refunds | Warned without multi-operations; tracked per refund with it | `:433`; `business-rules/multi-operations.md` Rule 4 |
| Reverse | Refunds the full amount when charged, cancels when only authorized; refuses a payment that already has a refund | `:580-617` (`business-rules/refunds-reversals.md` Rule 2) |
| Failure reporting | Every operation failure returns 200 `REJECTED` and writes nothing | `processor/src/services/abstract-payment.service.ts:136-172` |
| Health and components | `GET /operations/status`, `GET /operations/payment-components` (`dropin: embedded`, `express: dropin`) | `processor/src/services/stripe-payment.service.ts:232-310` |

## 5. Recurring off-session charges

| Capability | How | File |
| --- | --- | --- |
| Charge an installment | `POST /operations/transactions` (OAuth2 + `manage_checkout_transactions`) charges the customer's saved method off-session, confirmed immediately, automatic capture, no redirects; answers 201 with `Completed`, `Pending` or `Failed` | `processor/src/routes/operation.route.ts:118`; `processor/src/services/stripe-payment.service.ts:3048-3380` |
| Idempotency | The installment id is the `Payment.key` and the Stripe key `charge-{installmentId}`; a resolved installment is returned, not charged again | `:3147-3151`, `:3306` (`business-rules/recurring-charges.md` Rules 1, 5-6) |
| Ownership | The cart must have a customer; the saved method must belong to the resolved Stripe customer | `:3071`, `:3557-3579` (Rules 2, 7-8) |
| Amount | Always the cart amount; a smaller requested amount is validated and ignored | `:3101-3119` |
| Saving the method in the first place | A recurring cart forces `setup_future_usage: off_session` on its checkout payment | `:684-687`, `:782` |

## 6. Webhook-driven Payment updates

The 12 registered events and what each writes are in `ARCHITECTURE.md` §9. In short:

| Event | Effect |
| --- | --- |
| `payment_intent.succeeded` | `Charge/Success`; promotes a lingering `Authorization/Pending`; stores the payment method |
| `payment_intent.processing` | `Authorization/Pending`, deduped — failures rethrown so Stripe retries |
| `payment_intent.requires_action` | `Authorization/Pending` for bank transfer only |
| `payment_intent.partially_funded` | no transaction (§3) |
| `payment_intent.canceled` | `Authorization/Failure` + `CancelAuthorization/Success` at the full amount |
| `payment_intent.payment_failed` | `Authorization/Failure` |
| `charge.succeeded` | `Authorization/Success`: the existing authorization moves to `Success` at its own amount; stores the payment method |
| `charge.refunded` | `Refund/Success` + `Chargeback/Success` |
| `charge.updated` | the capture delta, with multi-operations only |
| `refund.updated`, `refund.failed` | `Refund/Failure`, only for a failed or canceled refund; successes are owned by `charge.refunded` (`business-rules/refunds-reversals.md` Rule 6) |
| `customer_cash_balance_transaction.created` | log only; `funding_reversed` and `adjusted_for_overdraft` at error level |

The `pspInteraction` payload is redacted before it is handed to `updatePayment`
(`business-rules/webhook-handling.md` Rule 9).

## 7. `Order.paymentState`

| Writer | When | What |
| --- | --- | --- |
| order-subscriber | `OrderCreated`, `OrderCreatedFromRecurringOrder`, onto an **unset** state only | `Paid` when this connector's payments have a `Charge/Success` and settled charges cover the gross total; else `Pending` on an `Authorization/Pending`; else nothing — so a manual-capture order stays unset (`order-subscriber/src/guard.ts:189-206`) |
| processor | on `requires_action`, `processing` → `Pending`; `succeeded` → `Paid`; `payment_failed`, `canceled` → `Failed` | never leaves `Paid`, writes `Pending` only onto unset, writes a terminal state only on an order it "owns", and `Paid` only when charges cover the total (`processor/src/utils.ts:117-159`; `processor/src/services/stripe-payment.service.ts:2266-2387`) |

Rules, the per-method outcome table and the reasons are in `business-rules/order-payment-state.md`.
Requires `manage_orders` on both modules' API clients.

## 8. Tax

| Capability | How | File |
| --- | --- | --- |
| External tax calculation | Reads `connectorStripeTax_calculationReferences` from the cart; with exactly one reference, forwards it through `hooks.inputs.tax.calculation`; with zero or several, sends none | `processor/src/services/stripe-payment.service.ts:1026-1041`, `:1523-1531` (`business-rules/payment-lifecycle.md` Rule 12) |

## 9. Configuration-Driven Behavior

| Setting | Changes | Where documented |
| --- | --- | --- |
| `STRIPE_PAYMENT_BEHAVIOR_RULES` | per-market `flowType`, `captureMethod`, `setupFutureUsage`, `collectBillingAddress`, `euBankTransferCountry`, keyed on `cart.country` then `cart.store.key` — never on shopper-supplied addresses; malformed JSON aborts startup | `business-rules/payment-behavior-rules.md` |
| `STRIPE_PAYMENT_FLOW` | `deferred` (PaymentIntent at confirm) or `pi_first` (before mount); any other value falls back to `deferred` with a warning | — |
| `STRIPE_CAPTURE_METHOD` | `automatic` (default) or `manual` | — |
| `STRIPE_ENABLE_MULTI_OPERATIONS` | partial captures, multiple refunds, `charge.updated` processing; only the string `'true'` enables | `business-rules/multi-operations.md` |
| `STRIPE_PAYMENT_INTENT_SETUP_FUTURE_USAGE`, `STRIPE_SAVED_PAYMENT_METHODS_CONFIG` | whether and how methods are saved; precedence in `business-rules/customer-session.md` Rule 5 | — |
| `STRIPE_COLLECT_BILLING_ADDRESS`, `STRIPE_LAYOUT`, `STRIPE_APPEARANCE_PAYMENT_ELEMENT`, `STRIPE_BEHAVIOR_PAYMENT_ELEMENT`, `STRIPE_EXPRESS_ELEMENT_OPTIONS` | element appearance and behaviour; invalid JSON falls back to `{}` without an error | `ARCHITECTURE.md` §10 |
| `ALLOWED_ORIGINS` | origin check on `/express-config` | — |
| `PAYMENT_INTERFACE` | the interface stamped on Payments — **must stay `checkout-stripe`** for the order-subscriber to work | — |

## 10. Out of Scope

| Feature | Why |
| --- | --- |
| Order creation | commercetools Checkout creates the order; this connector only updates `paymentState` |
| Individual payment-method components | `createComponentBuilder` always throws |
| Hosted Payment Page | commented out of the drop-in registry (`enabler/src/payment-enabler/payment-enabler-mock.ts:218-221`) |
| Stripe Billing subscriptions and invoices | no `invoice.*` or `customer.subscription.*` event registered; recurring orders are charged off-session per installment (§5) |
| Disputes | no `charge.dispute.*` event registered — disputes are manual; `Chargeback` transactions come only from refunds |
| SetupIntent (save now, charge later without paying) | no SetupIntent call in the code |
| Reconciliation of stale `Pending` authorizations | none, deliberately |
| `Order.paymentState` `BalanceDue`, `CreditOwed` | never written |
| EU bank transfer outside EUR or DE/FR/IE/NL | no `customer_balance` options (§3) |
| Tax calculation | not computed here (§8) |
| Launchpad purchase-order fields | the custom type is only checked for at deploy; nothing reads or writes its fields |
| Cash balance movements | logged, never written to commercetools |
| Stripe Terminal, Stripe Connect, coupon or price sync | no code in this unit |
