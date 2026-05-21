# Knowledge Base Index — ct-connect-stripe-checkout

**What this connector covers:** Stripe Payment Element + Express Checkout integration for commercetools. Handles one-time payments, 3DS, refunds, multi-capture, and Stripe Tax forwarding.

**What this connector does NOT cover:** Subscriptions, mixed carts, coupon sync, price sync. See `feature-scope.md → Out of Scope` for the full list.

For questions about the Integration as a whole (failure modes, connector selection, shared payment rules), see `../../context/index.md`.

---

## Route by Question Type

### "Can I / Is it possible to...?"

| Question | Document |
| --- | --- |
| Does this connector support feature X? | `feature-scope.md` |
| Can I do subscriptions with this connector? | `feature-scope.md → Out of Scope` — answer is no |
| Can I do partial captures? | `feature-scope.md` + `business-rules/multi-operations.md` |
| Can I save payment methods for future use? | `business-rules/customer-session.md` |
| Does this connector handle 3DS? | `feature-scope.md` + `ARCHITECTURE.md` |

### "How does X work?"

| Question | Document |
| --- | --- |
| How does the payment flow work end to end? | `ARCHITECTURE.md` |
| How are webhooks processed? | `business-rules/webhook-handling.md` |
| How are refunds processed? | `business-rules/refunds-reversals.md` |
| How does multi-capture work? | `business-rules/multi-operations.md` |
| How does customer session / saved methods work? | `business-rules/customer-session.md` |
| How does the payment lifecycle map to CT transactions? | `business-rules/payment-lifecycle.md` |

### "What happens when X fails?"

| Question | Document |
| --- | --- |
| What happens when Stripe is down? | `../../context/failure-modes.md` |
| What happens when CT is down? | `../../context/failure-modes.md` |
| What are the known technical gotchas? | `known-issues.md` |
| What happens on a CT 409 conflict? | `known-issues.md` + `../../context/known-issues.md` |

### "What are the rules for X?"

| Question | Document |
| --- | --- |
| Rules for refunds | `business-rules/refunds-reversals.md` |
| Rules for webhooks | `business-rules/webhook-handling.md` |
| Rules for multi-capture | `business-rules/multi-operations.md` |
| Universal Stripe + CT rules | `../../context/business-rules/stripe-ct-shared.md` |
| Universal refund rules | `../../context/business-rules/refunds.md` |
| Why was architectural decision X made? | `decisions/` |

---

## Reading Order by Role

### Adopting this connector (installing for the first time)

1. `adopter-guide.md` — prerequisites, deploy steps, env vars, enabler integration, verification

### New to this connector (developer onboarding)

1. `ARCHITECTURE.md` — system overview, components, API endpoints
2. `feature-scope.md` — what's supported and what's not
3. `business-rules/payment-lifecycle.md` — how payments flow through Stripe and CT
4. `known-issues.md` — gotchas specific to this connector

### Implementing a feature
1. Read hub `CLAUDE.md` + `../../context/known-issues.md` first
2. Read `ARCHITECTURE.md` for the relevant component
3. Read the `business-rules/` file for the domain being touched
4. Check `feature-scope.md` to confirm the feature is in scope

### Debugging a payment issue
1. `known-issues.md` — connector-specific gotchas
2. `../../context/known-issues.md` — hub-level gotchas (409, webhook duplicates)
3. `business-rules/payment-lifecycle.md` — expected state transitions
4. `business-rules/webhook-handling.md` — expected webhook behavior
