# ct-connect-stripe-checkout — Architecture

## At a glance

| # | Section | What decides whether to read it |
| --- | --- | --- |
| 1 | Overview | Three applications from one `connect.yaml`: browser enabler, processor service, order-subscriber event app |
| 2 | Projects | One row per module; `jwt-server/` and `docs/` are not modules |
| 3 | Shared Infrastructure | Directory tree of the unit |
| 4 | Placement and cross-module contracts | Why there is one `context/`, and every contract one module publishes and another reads |
| 5 | Sub-Project Architecture | Internal layout of each module |
| 6 | Entry Points | Every trigger, its auth, and **who calls it** |
| 7 | Integration Boundaries | Every Stripe and commercetools call, grouped by operation |
| 8 | Shared Domain | Payment, transactions, `Order.paymentState`, payment interface, custom types |
| 9 | Webhook Event Subscriptions | The 12 registered events and what each writes |
| 10 | Key Configuration | Every setting across the three modules, with its real default and whether the manifest declares it |
| 11 | Out of Scope | What the code does not do |

---

## 1. Overview

A commercetools Connect payment connector for Stripe, built for commercetools Checkout. Three
applications deploy together from one manifest (`connect.yaml:1-149`):

- **enabler** — a browser bundle the merchant's checkout constructs as `new Enabler(options)`. It
  mounts the Stripe Payment Element (drop-in) or the Express Checkout Element and calls the
  processor over HTTP (`enabler/src/main.ts:3`, `enabler/src/payment-enabler/payment-enabler-mock.ts:95`).
- **processor** — a Fastify service. It creates and confirms PaymentIntents for the session cart,
  runs capture / cancel / refund / reverse for the platform, charges saved methods off-session for
  recurring orders, and turns Stripe webhooks into commercetools Payment transactions and
  `Order.paymentState` (`processor/src/routes/stripe-payment.route.ts`, `processor/src/routes/operation.route.ts`).
- **order-subscriber** — a commercetools event app. On `OrderCreated` /
  `OrderCreatedFromRecurringOrder` it re-reads the order and writes `Paid` or `Pending` onto an
  unset `paymentState` (`order-subscriber/src/constants.ts:15`, `order-subscriber/src/guard.ts:189-206`).

**Why the order-subscriber exists as a separate application.** For a card the money settles before
commercetools Checkout creates the order, so the webhook path has no order to write onto; the
subscriber writes when the order appears.

**This connector never creates orders.** No order-create call exists in `processor/src`; the
processor only reads orders and writes `paymentState` (`processor/src/services/stripe-payment.service.ts:2418`,
`:2572-2581`).

## 2. Projects

| Project | Type | Stack | Purpose |
| --- | --- | --- | --- |
| `enabler/` | ui (browser library) | TypeScript 5.9, Vite 7 library build (`es` + `umd`), `@stripe/stripe-js ^5.6.0` (lock: 5.10.0), Node `>=24.22.1` at build time | Mounts Stripe elements in the host page and calls the processor (`enabler/vite.config.ts:11-18`, `enabler/package.json:19`) |
| `processor/` | service | TypeScript, Fastify 5.12, `@commercetools/connect-payments-sdk 1.2.2`, `stripe ^20.1.0` (lock: 20.4.1), Node `>=24.22.1` | Payment logic, payment operations, recurring charges, webhooks (`processor/package.json:22-24`) |
| `order-subscriber/` | event-handler | TypeScript 5.9, Fastify 5.12, Node `>=24.22.1` | Writes `Order.paymentState` when an order is created (`order-subscriber/package.json:21`) |

**Not modules.** `jwt-server/server.js` is a local JWT/JWKS mock used by `docker-compose.yaml`; it
has no dependency manifest and no `deployAs` entry. `docs/` holds two diagrams and no code.

## 3. Shared Infrastructure

```text
ct-connect-stripe-checkout/
├── connect.yaml          ← one manifest, three deployAs: enabler (assets) · order-subscriber (event) · processor (service)
├── docker-compose.yaml   ← local dev only
├── enabler/              ← browser bundle (Vite library mode)
├── processor/            ← Fastify service, endpoint "/"
├── order-subscriber/     ← Fastify event app, endpoint "/orderSubscriber"
├── jwt-server/           ← local JWT mock, not deployed
└── docs/                 ← two PNG diagrams
```

No module imports another. Two pieces of logic are **copied** between modules instead:

| Copy | Producer | Consumer |
| --- | --- | --- |
| `amountCoversOrderTotal` | `processor/src/utils.ts:200-206` | `order-subscriber/src/guard.ts:81-87` |
| `isBankTransferNextAction` | `processor/src/utils.ts:84-87` | `enabler/src/utils/index.ts:28-33` |

## 4. Placement and cross-module contracts

**Placement by the 3-Test Rule: modules that cannot be adopted alone share one `context/`.** All three
modules share one manifest, and each pair either cannot work alone or depends on data the other
writes — so there is one `context/` at the unit root and none inside a module.

| Pair | One manifest? | Usable alone? | Contract |
| --- | --- | --- | --- |
| enabler ↔ processor | yes (`connect.yaml:2-3`, `:33-35`) | no — every enabler setup call goes to `processorUrl` (`enabler/src/payment-enabler/payment-enabler-mock.ts:362-364`) | HTTP, 7 endpoints (§4.1) |
| processor ↔ order-subscriber | yes (`connect.yaml:4-32`) | each boots alone | **platform data** — the payment interface value and the transactions the processor writes (§4.2, §4.3) |
| enabler ↔ order-subscriber | yes | yes | none |

### 4.1 enabler → processor (HTTP)

Every field the enabler reads is present in the processor's response.

| Endpoint | Consumer | Producer | Result |
| --- | --- | --- | --- |
| `GET /config-element/payment` | `enabler/src/payment-enabler/payment-enabler-mock.ts:363` | `processor/src/services/stripe-payment.service.ts:1912-1924` | match |
| `GET /operations/config` | `payment-enabler-mock.ts:364` | `processor/src/services/stripe-payment.service.ts:215-221` | match |
| `POST /express-config` | `payment-enabler-mock.ts:314` | `processor/src/services/stripe-payment.service.ts:215-221` | match |
| `GET /customer/session` | `payment-enabler-mock.ts:436` | `processor/src/services/stripe-payment.service.ts:654-658` (204 when there is no customer) | match |
| `GET /payments` | `enabler/src/dropin/dropin-embedded.ts:131`, `enabler/src/express/dropin-express.ts:495`, `payment-enabler-mock.ts:372` | `processor/src/services/stripe-payment.service.ts:955-961` | match. Headers `x-express-checkout: 'true'` and `x-express-customer-session: 'true'` sent (`dropin-express.ts:595-600`); the processor accepts `'true'` or `'1'` for the first and only `'true'` for the second (`processor/src/routes/stripe-payment.route.ts:85-87`) |
| `POST /confirmPayments/:id` | `dropin-embedded.ts:247`, `dropin-express.ts:571` | `processor/src/routes/stripe-payment.route.ts:121-142` | fields match |
| `GET /express-payment-data` | `dropin-express.ts:240` | `processor/src/services/stripe-payment.service.ts:1852` | match |

### 4.2 processor → order-subscriber: `Payment.paymentMethodInfo.paymentInterface`

- **Written** by the processor from `PAYMENT_INTERFACE`, default `'checkout-stripe'`
  (`processor/src/config/config.ts:267`), onto every Payment it creates
  (`processor/src/services/stripe-payment.service.ts:900-920`). On the recurring path the caller
  may supply it (`processor/src/services/stripe-payment.service.ts:3216`).
- **Read** by the subscriber against `'checkout-stripe'`
  (`order-subscriber/src/constants.ts:39`, filter at `order-subscriber/src/clients/order.client.ts:136-139`).

### 4.3 processor ⇄ order-subscriber: `Payment.transactions` and `Order.paymentState`

- The subscriber decides from transactions the processor writes: any `Charge/Success` on this
  connector's payments → `Paid` (when settled charges cover the order's gross total); otherwise any
  `Authorization/Pending` → `Pending`; otherwise nothing (`order-subscriber/src/guard.ts:201-205`).
  The processor writes exactly those types and states (converter table in §9). Keys and values match.
- **Both modules write `Order.paymentState`** via `changePaymentState`
  (`processor/src/services/stripe-payment.service.ts:2572-2581`, `order-subscriber/src/clients/order.client.ts:194-205`).
  The processor gates with a lattice — never leave `Paid`, `Pending` only onto unset
  (`processor/src/utils.ts:154-159`); the subscriber writes only onto unset (`order-subscriber/src/guard.ts:24`).
- The processor writes `paymentState` on orders it creates a payment for; the subscriber writes
  `Paid` on card orders left unset (§1).
- Coverage compares settled `Charge/Success` money against `taxedPrice?.totalGross ?? totalPrice`
  (`processor/src/services/stripe-payment.service.ts:2346-2368`, `order-subscriber/src/guard.ts:96-100`).

### 4.4 Outside the unit

The processor reads the cart custom field `connectorStripeTax_calculationReferences`
(`processor/src/constants.ts:2`, read at `processor/src/services/stripe-payment.service.ts:1032`),
which no module of this unit writes — a separate tax connector does. Shape read: `string[]`; used
only when it holds exactly one entry.

## 5. Sub-Project Architecture

### enabler

```text
enabler/src/
├── main.ts                                   ← exports Enabler = MockPaymentEnabler
├── payment-enabler/payment-enabler.ts        ← public types: EnablerOptions, DropinOptions, ExpressOptions, builders
├── payment-enabler/payment-enabler-mock.ts   ← the shipped implementation: setup, config fetch, builders (setup cached per instance, :108-135)
├── dropin/dropin-embedded.ts                 ← Payment Element drop-in: mount, submit, confirm
├── express/dropin-express.ts, base.ts        ← Express Checkout Element, shipping callbacks, session refresh on click
├── converters/locale.converter.ts            ← Stripe locale mapping (falls back to 'auto')
├── utils/index.ts                            ← parseJSON, bank-transfer next_action check
└── components/base.ts, fake-sdk.ts, constants.ts ← not reached from main.ts
```

Control is inverted: the host checkout calls the bundle; Stripe.js calls back into the Express
handlers. No process and no port. Only `createDropinBuilder('embedded')` and
`createExpressBuilder('dropin')` produce a component; `createComponentBuilder` always throws.

### processor

```text
processor/src/
├── main.ts, server/                          ← Fastify on 0.0.0.0:8080; raw body for /stripe/webhooks; global CORS origin '*'
├── routes/stripe-payment.route.ts            ← session routes, /stripe/webhooks dispatcher, /express-config, /applePayConfig
├── routes/operation.route.ts                 ← /operations/* (session, JWT, OAuth2 + authority)
├── services/abstract-payment.service.ts      ← modifyPayment dispatch (capture, cancel, refund, reverse)
├── services/stripe-payment.service.ts        ← all payment logic
├── services/converters/stripeEventConverter.ts ← Stripe event → CT transactions; redacts pspInteraction
├── services/payment-behavior-resolver.ts     ← per-cart STRIPE_PAYMENT_BEHAVIOR_RULES, keyed on cart.country / store key
├── mappers/bank-transfer-mapper.ts           ← EU bank transfer options; detects rail suppression
├── services/commerce-tools/*                 ← customer, custom type, product type clients
├── connectors/                               ← post-deploy, pre-undeploy, actions
├── config/config.ts                          ← every environment read
└── utils.ts                                  ← order payment-state map and lattice, coverage, bank-transfer predicate
```

Two `StripePaymentService` instances exist: one for `/operations/*` (`processor/src/server/app.ts:4`)
and one for the browser and webhook routes (`processor/src/server/plugins/stripe-payment.plugin.ts:15`).

### order-subscriber

```text
order-subscriber/src/
├── main.ts, routes/order.route.ts            ← POST /orderSubscriber
├── controllers/order.controller.ts           ← 204 = handled or ignored; 500 = redeliver
├── validators/message.validator.ts           ← classify the Pub/Sub message
├── clients/order.client.ts                   ← fresh read with payments expanded; interface filter; write with one 409 re-resolve
├── guard.ts                                  ← write only onto unset; Paid outranks Pending; coverage
├── connectors/                               ← per-deployment Subscription delete + create / delete
└── config.ts                                 ← required() throws at import when a CTP_* key is missing
```

## 6. Entry Points

The caller is read from the auth hook, the registration that points at the entry, or the component
that calls it — never from the route name.

| Trigger | Module | Detail | Auth | Caller |
| --- | --- | --- | --- | --- |
| HTTP GET | processor | `/customer/session` (`processor/src/routes/stripe-payment.route.ts:48`) | session header | another application — the enabler |
| HTTP GET | processor | `/payments` (`:74`) | session header | another application — the enabler |
| HTTP POST | processor | `/confirmPayments/:id` (`:92`) → 200 approved · 202 pending · 400 rejected | session header | another application — the enabler |
| HTTP GET | processor | `/express-payment-data` (`:147`) | session header | another application — the enabler |
| HTTP GET | processor | `/config-element/:paymentComponent` (`:394`) | session header | another application — the enabler |
| HTTP POST | processor | `/express-config` (`:433`) | Origin allow-list (`ALLOWED_ORIGINS`) | another application — the enabler |
| HTTP GET | processor | `/applePayConfig` (`:419`) | public | — |
| HTTP POST | processor | `/stripe/webhooks` (`:208`) | Stripe signature (HMAC), verified in the handler (`stripe-payment.route.ts:220`) | external service callback — Stripe |
| HTTP GET | processor | `/operations/config` (`processor/src/routes/operation.route.ts:35`) | session header | another application — the enabler (`enabler/src/payment-enabler/payment-enabler-mock.ts:364`) |
| HTTP GET | processor | `/operations/status`, `/operations/payment-components` (`:51`, `:67`) | JWT | host platform |
| HTTP POST | processor | `/operations/payment-intents/:id` — capture, cancel, refund, reverse (`:83`) | OAuth2 + `manage_project` or `manage_checkout_payment_intents` | host platform, or an operator holding those scopes |
| HTTP POST | processor | `/operations/transactions` — recurring off-session charge → 201 (`:118`) | OAuth2 + `manage_project` or `manage_checkout_transactions` | host platform (commercetools recurring orders) |
| HTTP POST (Pub/Sub push) | order-subscriber | `/orderSubscriber` — `OrderCreated`, `OrderCreatedFromRecurringOrder` (`order-subscriber/src/main.ts:8`, `order-subscriber/src/routes/order.route.ts:8`) | — | host platform |
| Direct call | enabler | `new Enabler(options)` → `createDropinBuilder('embedded')`, `createExpressBuilder('dropin')` | session id forwarded as `X-Session-Id` | another application — the merchant checkout |
| Browser event | enabler | Express `click`, `confirm`, `cancel`, `shippingaddresschange`, `shippingratechange` (`enabler/src/express/dropin-express.ts:207-228`) | — | external service callback — Stripe.js |
| CLI | processor | `connector:post-deploy`, `connector:pre-undeploy` (`connect.yaml:37-38`) | — | host platform |
| CLI | order-subscriber | `connector:post-deploy`, `connector:pre-undeploy` (`connect.yaml:8-9`) | — | host platform |

## 7. Integration Boundaries

### Stripe (processor)

| Operation | Calls | File |
| --- | --- | --- |
| Create payment | `paymentIntents.create` (key `crypto.randomUUID()`), then `paymentIntents.update` to stamp `metadata.ct_payment_id` | `processor/src/services/stripe-payment.service.ts:859-877`, `:1392-1393` |
| Reuse an active payment | `paymentIntents.retrieve` per candidate, re-stamp when needed | `:1203-1352` |
| Confirm gate | `paymentIntents.retrieve` | `:1577` |
| Capture / cancel | `paymentIntents.retrieve` + `capture`; `cancel` | `:328`, `:350`, `:389` |
| Refund | `refunds.create` (key `refund-{paymentId}-{amount}`); `refunds.list` on multi-refund webhooks | `:488-495`, `:2746` |
| Recurring charge | `paymentIntents.create` off-session, confirm, automatic capture, key `charge-{installmentId}` | `:3306`, `:3317`, `:3602-3617` |
| Customer | `customers.retrieve`, `customers.search`, `customers.create`; `customerSessions.create`; `ephemeralKeys.create` (the only call given `STRIPE_API_VERSION`) | `:2881`, `:2896`, `:2908`, `:2940`, `:2962-2964` |
| Saved methods | `paymentMethods.retrieve`, `paymentMethods.list` (status check) | `:1983`, `:2619`, `:3578`, `:255` |
| Multicapture | `balanceTransactions.list` | `:2174` |
| Webhooks | `webhooks.constructEvent`; at deploy `webhookEndpoints.retrieve` + `update` | `processor/src/routes/stripe-payment.route.ts:220`; `processor/src/connectors/actions.ts:52`, `:64` |

### commercetools

| Operation | Calls | File |
| --- | --- | --- |
| Create payment | `getCart`, `createPayment` (key `pi-create-{cartId}-{cartVersion}`), `addPayment` | `processor/src/services/stripe-payment.service.ts:755`, `:897-936` |
| Confirm, webhooks, operations | `getPayment`, `updatePayment` (one call per transaction) | `:1555`, `:1658`, `:2070-2083` |
| Order payment state (processor) | `getOrderByPaymentId` (up to 5 attempts for a `Pending` target, 500/1500/3000/6000 ms), `orders.post changePaymentState` | `:2414-2431`, `:131`, `:2572` |
| Order payment state (subscriber) | `orders.get` with `paymentInfo.payments[*]` expanded, `orders.post changePaymentState` | `order-subscriber/src/clients/order.client.ts:41-45`, `:194-205` |
| Customer | `customers.get` (raw), `setCustomType` / `setCustomField` | `processor/src/services/stripe-payment.service.ts:2970`; `processor/src/services/commerce-tools/customerClient.ts:15` |
| Saved methods | `ctPaymentMethodService.get`, `getByTokenValue`, `save`; recurring job creation | `processor/src/services/stripe-payment.service.ts:3557`, `:3731`, `:3755`, `:2638` |
| Recurring dedup | `payments.get where key="…"` | `:3477-3483` |
| Install / uninstall | types, product types, subscriptions | `processor/src/services/commerce-tools/customTypeHelper.ts`; `order-subscriber/src/connectors/subscription.ts:15-43` |

## 8. Shared Domain

- **commercetools Payment** — created per `GET /payments` with an `Authorization/Initial` transaction
  whose `interactionId` is the PaymentIntent id (`processor/src/services/stripe-payment.service.ts:900-920`).
  The PaymentIntent carries `metadata.ct_payment_id` and `metadata.cart_id`; the confirm gate checks
  both against the session cart (`:1718-1737`). A repeated `GET /payments` reuses the cart's active
  payment instead of creating another (`:1203-1352`; `business-rules/payment-lifecycle.md` Rule 13).
- **Transaction vocabulary** — `Authorization` · `Charge` · `Refund` · `Chargeback` ·
  `CancelAuthorization`; states `Initial` · `Pending` · `Success` · `Failure`
  (`processor/src/dtos/operations/payment-intents.dto.ts:92-99`; states
  `processor/src/services/types/stripe-payment.type.ts:63-68`).
- **`Order.paymentState`** — the processor writes `Pending` · `Paid` · `Failed` (event map
  `processor/src/utils.ts:117-123`); the subscriber writes `Pending` · `Paid` (`order-subscriber/src/guard.ts:42`).
- **Payment interface `checkout-stripe`** — the ownership discriminator between the two modules (§4.2).
- **Tax** — no calculation of its own; one external calculation reference is forwarded through
  `hooks.inputs.tax.calculation` (`processor/src/services/stripe-payment.service.ts:1523-1531`).

### Custom types and product types

| Key (env override) | Resource | Created by post-deploy? | Removed by pre-undeploy? |
| --- | --- | --- | --- |
| `payment-connector-stripe-customer-id` (`CT_CUSTOM_TYPE_STRIPE_CUSTOMER_KEY`) | customer, field `stripeConnector_stripeCustomerId` | yes (`processor/src/connectors/post-deploy.ts:36`) | yes |
| `payment-launchpad-purchase-order` (`CT_CUSTOM_TYPE_LAUNCHPAD_PURCHASE_ORDER_KEY`) | payment | no — read and logged only (`processor/src/connectors/actions.ts:41-46`) | no |
| `payment-connector-subscription-line-item-type` (`CT_CUSTOM_TYPE_SUBSCRIPTION_LINE_ITEM_KEY`) | line-item | no | yes |
| `payment-connector-subscription-information` (`CT_PRODUCT_TYPE_SUBSCRIPTION_KEY`) | product-type | no | yes |

The order-subscriber creates one commercetools Subscription per deployment, keyed
`ct-connect-stripe-checkout-order-subscription-{topic}` (`order-subscriber/src/constants.ts:47`, `:73-76`).

## 9. Webhook Event Subscriptions

Registered on the Stripe endpoint by post-deploy, overwritten on every deploy whose endpoint URL has
changed (`processor/src/connectors/actions.ts:65-85`). Transactions per event from the converter
(`processor/src/services/converters/stripeEventConverter.ts:263-385`) and the route
(`processor/src/routes/stripe-payment.route.ts:257-382`).

| Event | CT write |
| --- | --- |
| `payment_intent.succeeded` | `Charge/Success` at `amount_received`; promotes a lingering `Authorization/Pending`; stores the payment method; order → `Paid` |
| `payment_intent.processing` | `Authorization/Pending` at `pi.amount`, deduped; order → `Pending` |
| `payment_intent.requires_action` | bank transfer only (`isBankTransferNextAction`, route `:324`): `Authorization/Pending`; order → `Pending` |
| `payment_intent.partially_funded` | no transaction; reaches the service only when the payload carries bank-transfer instructions (route `:324`) |
| `payment_intent.canceled` | `Authorization/Failure` **and** `CancelAuthorization/Success`, both at `pi.amount`; order → `Failed` |
| `payment_intent.payment_failed` | `Authorization/Failure` at `amount_received`; order → `Failed` |
| `charge.succeeded` | `Authorization/Success`: moves the existing authorization to `Success` at its own amount; stores the payment method |
| `charge.refunded` | `Refund/Success` **and** `Chargeback/Success` at `amount_refunded`; with multi-operations, the latest refund on the charge when the event is processed, under its id and amount (`processor/src/services/stripe-payment.service.ts:2746-2767`) |
| `charge.updated` | multi-operations only: `Charge/Success` for the capture delta; otherwise log-only |
| `refund.updated`, `refund.failed` | `Refund/Failure` at the refund's amount, only when its status is `failed` or `canceled` (route `:355`) |
| `customer_cash_balance_transaction.created` | never written; `funding_reversed` and `adjusted_for_overdraft` log at error (route `:200-205`) |

A PaymentIntent with no `metadata.ct_payment_id` is skipped with a 200 on every event, on purpose
(`processor/src/services/stripe-payment.service.ts:2026-2032`; `business-rules/webhook-handling.md` Rule 8).

## 10. Key Configuration

Union of every module's configuration reads, deduplicated. "Default" is the code's, which is what
runs when the setting is absent; "Manifest" is what `connect.yaml` declares.

| Variable | Module(s) | Default in code | Manifest | Effect |
| --- | --- | --- | --- | --- |
| `CTP_PROJECT_KEY` | processor, order-subscriber | processor `'payment-integration'` (`processor/src/config/config.ts:234`); subscriber **throws at import** (`order-subscriber/src/config.ts:10`, `:20-24`) | both, required | commercetools project |
| `CTP_CLIENT_ID`, `CTP_CLIENT_SECRET` | processor, order-subscriber | processor `'xxx'` (`config.ts:235-236`); subscriber throws | both, secured | API client. The subscriber needs `manage_orders` |
| `CTP_AUTH_URL`, `CTP_API_URL` | processor, order-subscriber | processor europe-west1 defaults (`config.ts:239-240`); subscriber throws | both, with defaults | OAuth and API endpoints |
| `CTP_SESSION_URL`, `CTP_CHECKOUT_URL`, `CTP_JWKS_URL`, `CTP_JWT_ISSUER` | processor | europe-west1 defaults (`config.ts:237-242`) | processor; `CTP_CHECKOUT_URL` required **with no default** in the manifest | Session API, Checkout API, JWT validation |
| `STRIPE_SECRET_KEY` | processor | `'stripeSecretKey'` (`config.ts:253`) | secured, required | Stripe API |
| `STRIPE_WEBHOOK_SIGNING_SECRET` | processor | `''` (`config.ts:254`) | secured, required | webhook HMAC |
| `STRIPE_PUBLISHABLE_KEY` | processor (served to the enabler) | `''` (`config.ts:257`) | required | Stripe.js initialisation |
| `STRIPE_WEBHOOK_ID` | processor post-deploy | `''` → endpoint not updated, stderr only (`processor/src/connectors/post-deploy.ts:20-26`) | required | which Stripe endpoint post-deploy points at the service |
| `STRIPE_CAPTURE_METHOD` | processor | `'automatic'` (`config.ts:255`) | default `automatic` | PaymentIntent `capture_method`; a behaviour rule can override per cart. `/express-config` and `/operations/config` report the env value only (`processor/src/services/stripe-payment.service.ts:218`) |
| `STRIPE_PAYMENT_FLOW` | processor | `'deferred'`; any other value warns and falls back, case-sensitive (`config.ts:316-327`) | default `deferred` | `pi_first` creates the PaymentIntent before the element mounts; a rule `flowType` overrides |
| `STRIPE_PAYMENT_BEHAVIOR_RULES` | processor | none; malformed JSON or structure **aborts startup**, bad field values are dropped (`config.ts:188-222`) | optional | per-cart overrides keyed by `cart.country`, then `cart.store.key` (`business-rules/payment-behavior-rules.md`) |
| `STRIPE_PAYMENT_INTENT_SETUP_FUTURE_USAGE` | processor | unset → falls back to the saved-methods usage; `''`/`none`/`null`/`undefined` → none (`processor/src/services/stripe-payment.service.ts:711-739`) | optional | PaymentIntent `setup_future_usage` |
| `STRIPE_SAVED_PAYMENT_METHODS_CONFIG` | processor | `{}`; invalid JSON falls back to `{}` (`config.ts:224-230`) | default `{"payment_method_save":"disabled"}` | customer-session saved methods |
| `STRIPE_ENABLE_MULTI_OPERATIONS` | processor | only the exact string `'true'` enables (`config.ts:288`) | default `'false'` | partial captures, multiple refunds, `charge.updated` processing |
| `STRIPE_APPEARANCE_PAYMENT_ELEMENT`, `STRIPE_LAYOUT`, `STRIPE_BEHAVIOR_PAYMENT_ELEMENT`, `STRIPE_COLLECT_BILLING_ADDRESS`, `STRIPE_EXPRESS_ELEMENT_OPTIONS` | processor (served to the enabler) | layout `{"type":"tabs","defaultCollapsed":false}`, billing `'auto'`; invalid element-options JSON → `{}` (`config.ts:256-264`, `processor/src/utils.ts:29-62`) | declared | element appearance and behaviour; Express options filtered to 7 keys in the enabler (`enabler/src/payment-enabler/payment-enabler-mock.ts:26-28`) |
| `STRIPE_APPLE_PAY_WELL_KNOWN` | processor | `'mockWellKnown'` (`config.ts:258`) | optional | `/applePayConfig` body |
| `STRIPE_API_VERSION` | processor | `'2025-12-15.clover'`; applied **only** to `ephemeralKeys.create` (`config.ts:259`) | default | — |
| `PAYMENT_INTERFACE` | processor | `'checkout-stripe'` (`config.ts:267`) | processor only, optional | Payment ownership discriminator (§4.2) |
| `MERCHANT_RETURN_URL` | processor | `''`; the session's value wins (`config.ts:268`, `processor/src/services/stripe-payment.service.ts:779`) | required | `confirmPayment` return URL |
| `ALLOWED_ORIGINS` | processor | `''` (`config.ts:275`) | required | CORS allow-list for `/express-config` |
| `CT_CUSTOM_TYPE_STRIPE_CUSTOMER_KEY`, `CT_CUSTOM_TYPE_LAUNCHPAD_PURCHASE_ORDER_KEY`, `CT_CUSTOM_TYPE_SUBSCRIPTION_LINE_ITEM_KEY`, `CT_PRODUCT_TYPE_SUBSCRIPTION_KEY` | processor | the keys in §8 (`processor/src/custom-types/custom-types.ts:4`, `:12`, `:40`, `:84`) | required, with defaults | type keys |
| `HEALTH_CHECK_TIMEOUT`, `LOGGER_LEVEL` | processor | `5000`, `'info'` (`config.ts:243`, `:246`) | **not declared** | health check, logging |
| `MOCK_ENVIRONMENT` | processor | `'TEST'` (`config.ts:250`) | **not declared** | used despite its name — returned as `environment` by `/operations/config` and `/express-config` |
| `MOCK_CLIENT_KEY` | processor | `'stripe'` (`config.ts:249`) | **not declared** | never read after config |
| `CONNECT_SERVICE_URL` | processor post-deploy | none; concatenated as `{url}stripe/webhooks` (`processor/src/connectors/post-deploy.ts:12`, `:29`) | injected by Connect | webhook URL |
| `CONNECT_GCP_TOPIC_NAME`, `CONNECT_GCP_PROJECT_ID` | order-subscriber | `''`; post-deploy throws without them (`order-subscriber/src/config.ts:15-16`, `order-subscriber/src/connectors/post-deploy.ts:16-21`) | injected by Connect | Subscription destination and key |
| `PORT` | order-subscriber | `8080` (`order-subscriber/src/config.ts:17`) | not declared | listen port (the processor hardcodes 8080, `processor/src/main.ts:12`) |

The enabler reads **no** environment variable at runtime: its configuration arrives through
constructor options and processor responses. Every key the manifest declares for the processor is
read somewhere in `processor/src`.

## 11. Out of Scope

| Feature | Status |
| --- | --- |
| Order creation | Not done, by design: the connector only updates `paymentState` (§1) |
| Individual payment-method components | `createComponentBuilder` always throws (`enabler/src/payment-enabler/payment-enabler-mock.ts:198-206`). Drop-in `embedded` and Express `dropin` only |
| Hosted Payment Page | `hpp` is commented out of the drop-in registry (`payment-enabler-mock.ts:218-221`) |
| Stripe Billing subscriptions and invoices | No `invoice.*` or `customer.subscription.*` event is registered (`processor/src/connectors/actions.ts:65-85`). Recurring orders are commercetools-driven and charged off-session through `POST /operations/transactions` (`business-rules/recurring-charges.md`) |
| Disputes | No `charge.dispute.*` event is registered; a `Chargeback` transaction is written only as a side effect of ordinary refunds |
| Reconciliation of stale `Pending` authorizations | None, by design |
| `Order.paymentState` `BalanceDue`, `CreditOwed` | Never written (`order-subscriber/src/guard.ts:42`, `processor/src/utils.ts:117-123`) |
| Manual-capture orders at creation | An authorization without a charge leaves the order's `paymentState` unset (`order-subscriber/src/guard.ts:201-205`) |
| EU bank transfer outside EUR or DE/FR/IE/NL | `customer_balance` options only for `eur` and those four IBAN countries (`processor/src/mappers/bank-transfer-mapper.ts:22`, `:66`) |
| Partial captures without the flag | A partial capture is rejected unless `STRIPE_ENABLE_MULTI_OPERATIONS=true` (`processor/src/services/stripe-payment.service.ts:338-348`) |
| Tax calculation | Not computed here; one external reference forwarded, none when there are several |
| Launchpad purchase-order fields | The custom type is only checked for at deploy; nothing in this unit reads or writes its fields |
| Customer cash balance changes | Logged, never written to commercetools (§9) |
| Stripe Terminal, Stripe Connect, coupon or price sync | No code in this unit |
