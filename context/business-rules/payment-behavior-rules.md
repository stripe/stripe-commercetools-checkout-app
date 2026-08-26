# Per-Cart Payment Behavior Rules

How `STRIPE_PAYMENT_BEHAVIOR_RULES` selects per-market overrides, which cart data is allowed to make
that selection, and what happens when a rule stops applying.

## Rule 1: A rule is selected only by merchant-controlled cart data

**What:** The discriminator that selects a `PaymentBehaviorRule` is read from `cart.country`, and
failing that `cart.store.key`. Never from `cart.billingAddress.country` or
`cart.shippingAddress.country`.

**Why:** Both address fields are shopper-supplied, and shopper-controlled *inside this connector*
rather than merely upstream of it — the express enabler writes the shopper's own address to the cart
(`enabler/src/express/dropin-express.ts`, `handleShippingAddressChange`). A discriminator a shopper can
set is a configuration switch a shopper can flip.

**Invariant:** Every field of `PaymentBehaviorRule` resolves through
`resolvePaymentBehaviorWithSteeringCheck`, which matches on merchant-controlled data only. There is no
exported resolver that matches on shopper-supplied data.

**Implementation:** `processor/src/services/payment-behavior-resolver.ts`

**Closure criterion:** `grep -rn "resolveUntrustedBehaviorForComparisonOnly" processor/src/` returns
hits only inside `payment-behavior-resolver.ts`, and the symbol is not exported. Any consumer outside
that file means the boundary has been reopened.

**What breaks if violated:** Steering `captureMethod` to `manual` in a market whose default is
`automatic` produces an authorization-only PaymentIntent. commercetools Checkout treats
`Authorization: Success` as a completed payment, so the order is created and fulfilled while that
market's operations team has no manual-capture process — the authorization then expires uncaptured.
Goods shipped against funds never taken. Steering `flowType` to `pi_first` on a recurring cart strips
the `setup_future_usage` that Priority 1 of `getPaymentIntentSetupFutureUsage` had forced, producing a
subscription with no saved mandate whose renewals fail later, away from checkout.

### Calibration — how much this boundary is actually worth (added 2026-08-13, SB3-207)

Two corrections, recorded because both errors point in expensive directions: one makes the boundary
sound stronger than it is and invites over-investment, the other makes it sound safer than it is.

**`euBankTransferCountry` is a treasury boundary, not a fund-diversion one.** Session material
described it as "selecting a destination account", which reads far stronger than the real exposure.
Accurately: even with the discriminator **fully compromised**, a shopper can only select among `DE`,
`FR`, `IE` and `NL` — all of them IBANs on the **merchant's own** Stripe account, all validated
against `EU_BANK_TRANSFER_COUNTRIES` at startup, so no unvalidated string reaches Stripe and no value
can name an account outside the merchant's. What actually moves is who absorbs cross-border transfer
fees, and whether the merchant presents as a local business in that market. Worth having. **Not worth
hardening further** — and worth saying so, because the stronger framing would justify work that buys
nothing.

**The discriminator is "not shopper-controlled *by us*", not "not shopper-controlled".**
`cart.country` and `cart.store.key` are unwritable by this connector — the processor issues only
custom-type and custom-field actions, verified — which is what Rule 1's invariant rests on. It is not
a claim about the whole system: **a storefront that exposes a country or store switcher still lets the
shopper steer which rule matches.** That is outside this connector's control and inside the threat
model of anyone deploying it. The code-side half of this correction already landed as a docblock on
`resolvePaymentBehaviorWithSteeringCheck` (`processor/src/services/payment-behavior-resolver.ts`) —
read it there rather than expecting it restated here.

---

## Rule 2: Both resolution sites must agree, always

**What:** `createPaymentIntentStripe` and `initializeCartPayment` must resolve the same rule for the
same cart, using the same resolver.

**Why:** The first builds the PaymentIntent; the second tells the enabler how to construct the
element. Stripe validates deferred element options against the retrieved intent at confirm.

**Invariant:** One resolver call shape at both sites. Neither site reads a field the other resolves
differently.

**Implementation:** `processor/src/services/stripe-payment.service.ts` — `createPaymentIntentStripe`
and `initializeCartPayment`

**Closure criterion:** the test *"both call sites honour the SAME rule for the same cart, across every
field"* in `processor/test/services/stripe-payment.service.spec.ts`. It uses a cart the trusted path
honours and a rule whose fields are all NON-DEFAULT, so "the two sites agree" cannot be satisfied by
both sites falling back to the same env var. An earlier version of that test did exactly that and
survived five separate mutations that made one site stop reading a rule field — if you weaken it back
toward asserting default values, it stops closing this rule.

> The criterion covers `captureMethod`, `collectBillingAddress` and `flowType`. `setupFutureUsage` is
> asserted only indirectly (via `flowType: 'pi_first'`, which suppresses it), and `euBankTransferCountry`
> is not read by `initializeCartPayment` at all, so there is no A/B surface for it.

**What breaks if violated:** A mismatch on `captureMethod` or `setupFutureUsage` makes Stripe reject
the confirm — a checkout outage for every cart in that market, failing closed. A mismatch on
`collectBillingAddress` is directional: an element told to hide the address fields while the processor
sends no `billing_details` is rejected, whereas the inverse is harmless. A mismatch on `flowType`
(config-element `pi_first`, PaymentIntent `deferred`) mints the intent *with* `setup_future_usage`,
which removes `customer_balance` from `payment_method_types` — the bank-transfer tab silently never
renders.

> **Known exception, not yet closed:** the flat `config()` accessor returns `stripeCaptureMethod`
> without consulting the rules at all. It backs `POST /express-config` — whose value the enabler feeds
> into `elements()` for the express-without-session path — and `/operations/config`. That third site
> already diverges from the other two for any merchant using a `captureMethod` rule. Queued separately.

---

## Rule 3: Discarding a rule field applies the opposite instruction, not none

**What:** When a field stops applying, the caller falls through to the flat environment variable. That
variable is an opinionated instruction, not a neutral default — so the result is frequently the
*inverse* of what the merchant configured, not the absence of a configuration.

**Why it is a rule and not a footnote:** two independent mechanisms reach this same state, which is
why it keeps being rediscovered:

| Mechanism | How the field is discarded |
| --- | --- |
| **Validation drops it** | `validateBehaviorRule` rejects an unusable value (e.g. `'None'`, `' off_session '`) and the field disappears from the rule |
| **The rule stops matching** | the discriminator no longer selects that rule — including, since 2026-08-13, any rule that was only reachable through shopper-supplied address data |

A third case — the merchant simply not setting the field — is the designed behaviour and is fine. The
hazard is specific to a field the merchant *did* set and that then went away.

**Invariant:** No code path may treat "the rule field is absent" as equivalent to "no instruction".

**Implementation:** `processor/src/config/config.ts` (the flat defaults),
`processor/src/services/stripe-payment.service.ts` (the `?? config.…` fall-throughs)

**Closure criterion:** for each row of the table below, the flat default in `config.ts` still differs
from the value a merchant would plausibly set in a rule — `grep -n "stripeCaptureMethod\|stripeCollectBillingAddress\|stripePaymentFlow\|stripePaymentIntentSetupFutureUsage" processor/src/config/config.ts`.
This rule is a *hazard statement*, not an invariant a test can hold: there is deliberately no code
preventing the fall-through, because the fall-through is the designed behaviour when a merchant simply
omits a field. What must not happen is a change that discards a field the merchant *did* set without
surfacing it — which is what `steeredFields` covers for the match-loss mechanism, and what
2026-08-07-010 is open for on the validation-drop mechanism.

**What breaks if violated — the concrete inversions:**

| Field | Falls back to | What the merchant actually gets |
| --- | --- | --- |
| `captureMethod` | `automatic` | funds are captured immediately, without the manual review the rule existed to require |
| `collectBillingAddress` | `auto` | `billing_details` are collected from the shopper in the element instead of being sent server-side from the cart — so Radar and AVS evaluate a shopper-typed address. The one field where losing the rule *reduces* server authority |
| `flowType` | `deferred` | Blik stops working, and the bank-transfer rail is suppressed (SB3-207) |
| `setupFutureUsage` | the flat env var | a market configured to disable the mandate receives it, or the mirror case silently loses it |

**Measured instance:** during SB3-207 Task A, validation dropped `setupFutureUsage` values that had
always worked. With `STRIPE_PAYMENT_INTENT_SETUP_FUTURE_USAGE=off_session` and a rule of
`{"MX":{"setupFutureUsage":"None"}}` — a rule whose entire purpose was to disable the mandate for that
market — every MX shopper would have received the mandate the merchant explicitly turned off.

**Merchant-facing consequence:** a rule that stops matching is not a no-op. Before narrowing what can
select a rule, check whether any market depends on a rule keyed to a country that carts do not carry
in `cart.country` — those markets revert to the table above.

---

## Rule 4: The steering signal is one-directional on purpose

**What:** `steeredFields` reports only fields where shopper-supplied data *would* have selected a
different value than the merchant-controlled path did. It stays silent when the trusted path finds a
rule the untrusted one missed.

**Why:** The two fallback orders differ rather than nest — the untrusted order tries billing/shipping
*before* `store.key`, the trusted one skips straight to `store.key`. So a shopper address can *shadow*
a store-key rule on the untrusted path, and the trusted resolver then finds a rule the untrusted one
missed. That direction is benign: it is the merchant's own configuration working correctly. Under
express checkout it would be the permanent state for any merchant using store-key rules, so a
symmetric comparison would sit at 100% true for them and be worthless as a signal.

**Invariant:** Field names only, never values. A rule can be selected by the shopper's own address, and
the log line already carries `cartId`, which resolves to an identified customer.

**Implementation:** `processor/src/services/payment-behavior-resolver.ts` —
`resolvePaymentBehaviorWithSteeringCheck`

**Closure criterion:** the tests *"stays SILENT when the trusted path finds a rule the untrusted one
missed"* and *"logs the rule as field NAMES, never as the rule object"*.

**What breaks if violated:** a symmetric signal is permanently true for store-key merchants and gets
ignored, so real steering stops being visible. Logging values instead of names leaks the discriminator
next to an identified customer, and silently logs every field later added to `PaymentBehaviorRule`.
