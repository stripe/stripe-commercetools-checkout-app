# ADR-011: Recurring off-session charge uses SDK 1.2.x native checkoutTransactionItemId linkage; interfaceId holds the real PaymentIntent id

**Status:** Accepted (ratified 2026-09-21). Implemented; 531/531 tests green; validated live against the deployed connector — a recurring off-session charge succeeded and the payment carries `key` = `checkoutTransactionItemId`, the native `checkoutTransactionItemId` linkage, `interfaceId` = the real Stripe PaymentIntent id, and `Charge/Success`. Amended the same day (see Amendment) for the `Payment.key` dedup.
**Date:** 2026-09-21
**Amended:** 2026-09-21 (session 2026-09-21-recurring-dedup-key) — dedup re-keyed from the non-queryable native `checkoutTransactionItemId` field onto the unique `Payment.key`; see Amendment note at end.
**Supersedes the *mechanism* of:** ADR-010 (its Decision — `checkoutTransactionItemId` as the sole idempotency anchor — is preserved unchanged; only the CT-lookup mechanism named in ADR-010's Context changes)

## Context

The connector was migrated to `@commercetools/connect-payments-sdk@1.2.2`. Under the previous 0.27.2 SDK,
`createPayment` had no `checkoutTransactionItemId` parameter, so `handleTransaction`
(`POST /operations/transactions`, off-session recurring charge) overloaded the CT payment-level
`interfaceId` field to carry the installment identity (`interfaceId = draft.checkoutTransactionItemId`).
That single value served two purposes at once: (1) the payment↔transaction-item link, and (2) the key for
the cross-window CT-level dedup (`findPaymentsByInterfaceId({ interfaceId: installmentKey })`).

SDK 1.2.x adds a native `createPayment({ checkoutTransactionItemId })` parameter (natively typed on
`PaymentDraft`), making the overload unnecessary. Keeping it also diverged from every other flow in the
connector, where `interfaceId` holds the real Stripe PaymentIntent id (ADR-003) — and it created a latent
bug: `capturePayment`/`cancelPayment`/`refundPayment` read `payment.interfaceId` as the PI id, so a
recurring payment whose `interfaceId` was the installment uuid would have failed those operations.

Freeing `interfaceId` to hold the PI id breaks the old dedup: `findPaymentsByInterfaceId({ interfaceId: installmentKey })`
no longer matches. A dedup that survives is required, because the stable Stripe idempotency key
(`charge-${checkoutTransactionItemId}`) only deduplicates within Stripe's ~24h retention window and the
concurrent TOCTOU window — a recurring retry of the same installment after 24h would otherwise double-charge.

## Decision

1. **Linkage:** the recurring `createPayment` uses the native `checkoutTransactionItemId` parameter; it no
   longer sets `interfaceId`.
2. **interfaceId:** stamped with the real Stripe PaymentIntent id after the charge, via `pspReference` on the
   post-charge `updatePayment`/booking calls (the SDK maps `pspReference` → `setInterfaceId`, and only when
   `interfaceId` is unset, so a webhook-written value is never clobbered). Matches the normal checkout flow
   and ADR-003.
3. **Cross-window dedup:** ~~re-keyed onto the native field via a raw CT query
   `payments().get({ queryArgs: { where: \`checkoutTransactionItemId="<id>"\` } })`~~ **[amended 2026-09-21 — the
   native field is not `where`-filterable on the deployed CT API; see Amendment].** Re-keyed onto the unique
   `Payment.key` (= `checkoutTransactionItemId`) via `payments().get({ queryArgs: { where: \`key="<id>"\` } })`.
   `key` is a queryable, project-unique CT field. Runs before IDOR resolution and PI create (step 5 → 6 → 10
   preserved). Fails closed: an unsupported predicate throws rather than returning a false-empty.
4. **Anchor value (from ADR-010) unchanged:** `installmentKey = draft.checkoutTransactionItemId`, a required
   uuid; idempotency key stays `charge-${installmentKey}`; caller `draft.idempotencyKey` ignored. The uuid
   format is now asserted in-service (defense-in-depth) before it is interpolated into the query predicate.

## Alternatives Considered

| Alternative | Why discarded |
| --- | --- |
| Option (a): drop the CT-level dedup, rely solely on the Stripe idempotency key (matches Adyen reference) | Stripe keys expire ~24h; a same-installment retry after that window double-charges. CT does not enforce uniqueness on `checkoutTransactionItemId` (verified: the SDK forwards the draft verbatim; no unique constraint), so `createPayment` would not hard-fail the duplicate. Rejected as a silent regression of the ADR-010 protection. |
| Keep overloading `interfaceId = installmentKey` | Diverges from ADR-003 and the rest of the connector; breaks recurring capture/cancel/refund; wastes the native SDK param. |
| Option (b2): store the installment id in an own custom field and dedup on that | More surface; re-introduces a workaround shape when a native field already exists. |

## Consequences

**Positive:** Native, correctly-typed linkage; `interfaceId` consistent with ADR-003 (fixes latent recurring
capture/cancel/refund); ADR-010's stable anchor and double-charge protection preserved; matches the reference
DTO contract.

**Negative:** ~~The cross-window dedup relies on the deployed CT API supporting `where=checkoutTransactionItemId="…"`.~~
**[Amended 2026-09-21 — that assumption was false and caused a production outage; see Amendment.]** The cross-window
dedup now relies on `Payment.key` uniqueness and queryability, both native, verified CT guarantees. `key`
additionally makes a concurrent duplicate `createPayment` hard-fail at the DB level (`DuplicateField`), giving
concurrent-safety natively — but it also means a stuck-`Authorization/Initial` payment must be **reused and
driven**, not re-created (a re-create would `DuplicateField`); the handler does this explicitly.

**Risks / open item:** With `key` unique, a payment seeded under a guessed uuid could theoretically interfere
with a future legitimate installment because `checkoutTransactionItemId` is caller-supplied and not bound to a
real cart transaction item (security MEDIUM-2, session 2026-09-21-recurring-dedup-key). Residual risk is LOW
(requires JWT + a valid customer-bound cart + passing the IDOR/saved-method resolver; the reuse branch drives
the legit charge against the IDOR-verified method rather than being suppressed) — deferred as a queued
follow-up (`workspace/2026-09-21-recurring-dedup-key/tasks-queue.json`). Also consider extracting the raw query
into `commerce-tools/paymentClient.ts` for layer consistency (arch review 🟡, deferred).

## Related

- Supersedes the mechanism of ADR-010 (recurring-idempotency-anchor). ADR-010 is itself *Proposed*; consider
  ratifying it or folding this into an amendment rather than a supersede chain (arch review note).
- ADR-003 (CT source of truth / PaymentIntent id as lookup key), ADR-009 (order-payment-state reflection),
  business-rules/order-payment-state.md Rule 4, known-issues.md KI-007 (idempotency keys).
- Session: `workspace/2026-09-21-align-recurring-transactions/`

## Amendment — 2026-09-21 (session 2026-09-21-recurring-dedup-key)

**What broke:** The original Decision item 3 assumed the native `checkoutTransactionItemId` field was usable as a
`where` predicate. It is not — it is a create-time / readable field only. The deployed CT API rejected
`where=checkoutTransactionItemId="…"` with `400 InvalidInput` ("The field checkoutTransactionItemId does not
exist"), which the connector wrapped as a 500. Every `POST /operations/transactions` 500'd at step 5 (after
`getPaymentAmount` succeeded, before any payment was created). This is exactly the fail-closed outage this ADR's
original Risks section flagged as possible.

**Fix (option b3 — `Payment.key`):**
- The recurring `createPayment` sets `key = checkoutTransactionItemId` **in addition to** the native
  `checkoutTransactionItemId` linkage (kept) and `interfaceId = real PI id via pspReference only-if-unset` (kept).
- Step-5 dedup queries `where=key="…"` (via `findPaymentByKey`), which CT's field list confirms is supported —
  the same predicate shape already used on `types()` in `customTypeClient.ts`.
- CT enforces `key` uniqueness per project, so a concurrent/duplicate `createPayment` for the same installment
  hard-fails with `DuplicateField` before any Stripe call. The handler catches that (narrowly: statusCode 400 +
  `DuplicateField` on field `key`), re-fetches by key with an ownership re-check, and returns the winner's
  outcome idempotently — no second Stripe create/charge. This provides both the >24h cross-window protection and
  concurrent-safety natively.
- A stuck-`Authorization/Initial` payment (prior attempt died pre-Stripe) is **reused and driven** through the
  charge rather than re-created — preserving the ADR-010 "retry rather than freeze" invariant under the new
  unique-key constraint (would otherwise under-charge; security MEDIUM-1).

**Spike verification (all confirmed before implementing):** `PaymentDraft.key` is native platform-sdk and
forwarded verbatim by the SDK's `createPayment`; `where=key="…"` / typed `withKey` is supported; the duplicate
error is `statusCode 400` with `errors[].code='DuplicateField'`, `field='key'`; a uuid is a valid CT key.
