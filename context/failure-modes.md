# Failure Modes — ct-connect-stripe-checkout

Operational failure scenarios for this connector are shared identically with `ct-connect-stripe-composable` — same code pattern (Payment Intent operations, webhook processing, webhook endpoint update at post-deploy, Stripe/CT unavailability, webhook signature verification), same blast radius, just different line numbers. They live in `../../context/failure-modes.md` rather than being duplicated here.

No failure scenario specific to this connector alone has been identified as of 2026-07-27 — `checkout` has no subscription/product-type post-deploy step (unlike `composable`, see its own `context/failure-modes.md`), and no other connector-unique external-service failure path was found during the last refresh. If one is found later, add it here rather than in the shared file.
