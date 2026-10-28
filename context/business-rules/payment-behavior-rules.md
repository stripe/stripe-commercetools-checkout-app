# Per-Cart Payment Behavior Rules

How `STRIPE_PAYMENT_BEHAVIOR_RULES` selects per-market overrides of flow type, capture method, setup
future usage, billing address collection and bank transfer country — which cart data selects a rule,
how the map is validated, and what happens when a rule stops applying.

## Rule 1: A rule is selected only by merchant-controlled cart data

**What:** The discriminator that selects a `PaymentBehaviorRule` is read from `cart.country`, and
failing that `cart.store.key`, never from `cart.billingAddress.country` or
`cart.shippingAddress.country`. A second resolution that also considers the two address countries is
computed only to report steering (Rule 4); its value is never applied.

**Invariant:** Every field of `PaymentBehaviorRule` resolves through
`resolvePaymentBehaviorWithSteeringCheck`, which matches on merchant-controlled data only
(`extractTrustedDiscriminator` reads only `cart.country` and `cart.store.key`). There is no exported
resolver that matches on shopper-supplied data, and the untrusted resolution's value is never applied
to a PaymentIntent or element.

**Implementation:** `processor/src/services/payment-behavior-resolver.ts` — `extractTrustedDiscriminator`
(`:133-145`), `resolveTrustedPaymentBehavior` (`:159-171`), the unexported
`resolveUntrustedBehaviorForComparisonOnly` (`:95-107`), and `resolvePaymentBehaviorWithSteeringCheck`
(`:242-266`), whose untrusted result feeds only `steeredFields`. Callers:
`processor/src/services/stripe-payment.service.ts:767-770` (`createPaymentIntentStripe`) and `:1880`
(`initializeCartPayment`).

## Rule 2: Both resolution sites resolve the same rule

**What:** `createPaymentIntentStripe` and `initializeCartPayment` resolve the same rule for the same
cart, using the same resolver.

**Why:** The first builds the PaymentIntent; the second tells the enabler how to construct the
element. Stripe validates deferred element options against the retrieved intent at confirm.

**Invariant:** One resolver call shape at both sites. Neither site reads a field the other resolves
differently.

**Implementation:** `processor/src/services/stripe-payment.service.ts` — `createPaymentIntentStripe`
(`:750-962`, resolution `:767-782`) and `initializeCartPayment` (`:1861-1925`, resolution `:1880-1893`).

## Rule 3: An omitted or non-matching rule field falls back to the flat setting

**What:** Each of `flowType`, `captureMethod`, `setupFutureUsage` and `collectBillingAddress` overrides
per field. When the rule omits a field, or the field stops applying, the caller falls through to the
flat environment variable.

**Invariant:** Every effective value is `rule field ?? flat setting`, and no field is read from the
rule without that fallback.

**Flat defaults:** `captureMethod` → `automatic`, `collectBillingAddress` → `auto`, `flowType` →
`deferred`, `setupFutureUsage` → `STRIPE_PAYMENT_INTENT_SETUP_FUTURE_USAGE`.

**Implementation:** `processor/src/config/config.ts` (the flat defaults: `stripeCaptureMethod` `:255`,
`stripeCollectBillingAddress` `:262`, `stripePaymentIntentSetupFutureUsage` `:302`, `stripePaymentFlow`
`:316-327`; field validation `validateBehaviorRule` `:78-175`, drop report `dropField` `:40-47`),
`processor/src/services/stripe-payment.service.ts` (the fall-throughs: capture `:778`, flow `:781`,
setup future usage `:689-692` inside `getPaymentIntentSetupFutureUsage`, billing address `:1411`; and in
`initializeCartPayment` `:1881-1883`, `:1890-1893`).

## Rule 4: The resolved rule is logged by field name only

**What:** `steeredFields` reports, as field names only and never as values, the fields where the
untrusted resolution would have selected a different value than the merchant-controlled path did. It
is silent when the trusted path finds a rule the untrusted one did not.

**Invariant:** Field names only, never values.

**Implementation:** `processor/src/services/payment-behavior-resolver.ts:242-266` —
`resolvePaymentBehaviorWithSteeringCheck` (silent case `:259-261`, comparison `:263`); field list and its
compile-time exhaustiveness guard `:182-196`; the log
`processor/src/services/stripe-payment.service.ts:969-992` → `logResolvedBehaviorRule`.

## Rule 5: A structurally malformed rules value stops the processor at startup

**What:** Invalid JSON, a value that is not a plain object, or a rule that is not a plain object throws
while loading configuration. A whitespace-only value is treated as absent. Field-level problems never
abort (Rule 3).

**Why:** A rule set that cannot be read as a whole has no per-field fallback
(`processor/src/config/config.ts:177-187`).

**Invariant:** `getPaymentBehaviorConfig` throws for each of the three structural shapes and for
nothing else.

**Implementation:** `processor/src/config/config.ts:188-222` (trim `:193`, JSON `:196-203`, map shape
`:205-210`, rule shape `:212-218`).

## Rule 6: `euBankTransferCountry` pins the IBAN country of a EUR cart; it does not decide whether bank transfer is offered

**What:** A rule's `euBankTransferCountry` has one effect on the PaymentIntent: for a cart in `eur`, it
sends `payment_method_options.customer_balance` with `funding_type: bank_transfer` and
`eu_bank_transfer.country` set to that country; for any other currency, or with no country configured,
nothing is sent. Whether bank transfer is offered is decided elsewhere: the PaymentIntent uses
`automatic_payment_methods` and never lists `payment_method_types`, so a EUR cart whose PaymentIntent
carries a Stripe customer is offered `customer_balance` with or without a rule — with Stripe's
currency-derived Irish IBAN when no country is configured. A customer is bound when the commercetools
customer has a stored Stripe customer id and the payment is not Express-without-customer
(`stripe-payment.service.ts:812`, `:1464-1468`); without one, Stripe omits the rail. Stripe also drops
it when `setup_future_usage` is binding or capture is `manual` (Rule 8).

**Why:** Choosing the IBAN country is a merchant treasury preference — normally the merchant's own
country, to spare the shopper cross-border fees — not a technical requirement
(`bank-transfer-mapper.ts:42-45`). Non-EUR carts are left untouched so Stripe picks the local variant
(e.g. `gb_bank_transfer` for GBP) (`bank-transfer-mapper.ts:47-53`).

**Invariant:** `euBankTransferCountry` reaches the PaymentIntent only through `getBankTransferOptions`,
which returns `undefined` unless the currency is `eur` and a country is configured; the PaymentIntent's
offered methods are never restricted by it (`automatic_payment_methods: { enabled: true }`, no
`payment_method_types`).

**Implementation:** `processor/src/mappers/bank-transfer-mapper.ts:59-80`;
`processor/src/services/stripe-payment.service.ts:771` (read from the rule), `:1456-1459` (options built),
`:1471-1473` (`automatic_payment_methods`), `:1521` (options written as a sibling of `card`).

## Rule 7: The bank transfer country is one of DE, FR, IE, NL

**What:** A rule's `euBankTransferCountry` must be `DE`, `FR`, `IE` or `NL` (case-insensitive,
canonicalised to upper case). Any other value is dropped from the rule and reported at startup; startup
continues and the market falls back to Stripe's currency-derived IBAN.

**Why:** These are the countries Stripe accepts inside `eu_bank_transfer.country`. Stripe types the
field as a plain `string`, so the union is the only thing between a typo and a 400
(`processor/src/mappers/bank-transfer-mapper.ts:4-21`). The list is single-sourced in the mapper and
validated against at config load.

**Invariant:** `validateBehaviorRule` keeps `euBankTransferCountry` only when its canonical form is a
member of `EU_BANK_TRANSFER_COUNTRIES`.

**Implementation:** `processor/src/mappers/bank-transfer-mapper.ts:22-24`;
`processor/src/config/config.ts:150-163`.

## Rule 8: A rule whose bank transfer will not take effect is warned about — at startup and per PaymentIntent

**What:** When a rule sets `euBankTransferCountry` but the effective `setup_future_usage` is binding
(`off_session`/`on_session`) or `capture_method` is `manual`, `customer_balance` is not offered, and a
warning is logged at startup (naming the market and the remedy) and again per PaymentIntent for an `eur`
cart (booleans only, never the market). `automatic_async` does not trigger the warning.

**Why:** The connector does not rewrite the merchant's mandate or capture policy to force the rail back
on; it warns instead. The startup warning cannot see recurring carts, which force `off_session` per
cart, so a per-PaymentIntent warning covers that case
(`processor/src/services/stripe-payment.service.ts:784-803`).

**Invariant:** `findRailSuppressionAtStartup` returns a warning for every market whose effective inputs
remove the rail, and none for healthy ones; `warnIfRailSuppressed` logs whenever this applies to an
`eur` cart that resolved an IBAN country.

**Implementation:** `processor/src/mappers/bank-transfer-mapper.ts:134-154` (`resolveRailSuppression`),
`:285-310` (effective inputs, `pi_first` un-suppresses), `:312-358` (`findRailSuppressionAtStartup`);
startup call `processor/src/config/config.ts:356-365`; runtime
`processor/src/services/stripe-payment.service.ts:804-810` → `warnIfRailSuppressed` (`:999-1019`).
