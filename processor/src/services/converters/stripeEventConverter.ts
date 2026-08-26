import { TransactionData, Money } from '@commercetools/connect-payments-sdk';

import Stripe from 'stripe';
import { PaymentStatus, StripeEvent, StripeEventUpdatePayment } from '../types/stripe-payment.type';
import { PaymentTransactions } from '../../dtos/operations/payment-intents.dto';
import { wrapStripeError } from '../../clients/stripe.client';

export class StripeEventConverter {
  /**
   * @param resolvedPaymentMethod The payment method type for a `payment_intent.*` event, resolved by
   *   the CALLER. Ignored for Charge events, which carry `payment_method_details.type` in the payload
   *   and need no help.
   *
   *   WHY THE CALLER RESOLVES IT AND NOT THIS METHOD. A PaymentIntent payload names its method only
   *   by id (`payment_method: 'pm_…'`); the type lives on the PaymentMethod object, which takes a
   *   Stripe call to read. This converter is a **pure function of the payload** — no I/O, no clock,
   *   no commercetools state — and that invariant is what makes it exhaustively testable from
   *   fixtures. Doing the retrieve here would make `convert` async and put a network call inside the
   *   one place in this flow that has none. So the I/O stays in the service and the answer arrives
   *   as data. See `resolvePaymentMethodType()` in `stripe-payment.service.ts`.
   */
  public convert(opts: Stripe.Event, resolvedPaymentMethod?: string): StripeEventUpdatePayment {
    // customer_cash_balance_transaction.created is observability-only: the event object is
    // customer-scoped, carries no ct_payment_id, and has no commercetools transaction model in
    // v1. The route must never send it here. Rejecting it explicitly makes that invariant
    // self-enforcing instead of relying on the route switch alone, and produces a readable error
    // instead of the cast failure it would otherwise hit below — `opts.type` does not start with
    // `payment`, so it would be read as a Charge and `getCtPaymentId` would dereference a
    // `metadata` that is not there.
    if (opts.type === StripeEvent.CUSTOMER_CASH_BALANCE_TRANSACTION__CREATED) {
      throw wrapStripeError(new Error(`Event ${opts.type} is observability-only and must not be converted`));
    }

    let data, paymentIntentId, paymentMethod;
    if (opts.type.startsWith('payment')) {
      data = opts.data.object as Stripe.PaymentIntent;
      paymentIntentId = data.id;
      // Left EMPTY before 2026-08-21, which is why a bank transfer sitting at Pending showed no
      // payment method in commercetools at all: this branch handles every `payment_intent.*` event,
      // and the settling Charge that would have filled the field arrives days later — or never, if
      // the shopper abandons the transfer. Reported by Luis against a real Pending order.
      //
      // Deliberately NOT defaulted to `''` when unresolved: an empty string overwrites a method the
      // Charge branch may already have written, whereas `undefined` leaves the field alone. That
      // matters because these events arrive repeatedly for one payment and Stripe redelivers for
      // three days.
      paymentMethod = resolvedPaymentMethod;
    } else {
      data = opts.data.object as Stripe.Charge;
      paymentIntentId = (data.payment_intent || data.id) as string;
      paymentMethod = (data.payment_method_details?.type as string) || '';
    }

    return {
      id: this.getCtPaymentId(data),
      pspReference: paymentIntentId,
      paymentMethodInfo: {
        method: paymentMethod,
      },
      pspInteraction: {
        response: this.buildPspInteractionResponse(opts),
      },
      transactions: this.populateTransactions(opts, paymentIntentId),
    };
  }

  /**
   * The only fields kept from anywhere inside `next_action`. Everything else is dropped.
   *
   * This is an ALLOWLIST, and that is the whole point: `next_action` currently has EIGHTEEN
   * variants (Stripe.PaymentIntent.NextAction, verified against the installed SDK), most of
   * which carry a hosted URL, a QR code payload, or a voucher number. An enumerated denylist
   * over the eighteen known ones fails OPEN on the nineteenth — a variant Stripe adds in a
   * future API version would be persisted verbatim, silently. An allowlist fails CLOSED: an
   * unknown field is not on the list, so it is dropped. This repo has already lost a guard to
   * a silent Stripe field change once.
   *
   * The exact number is not the argument and will go stale — Stripe adds payment methods
   * regularly, which is itself the reason enumerating is the wrong shape. Recount with:
   *   sed -n '741,790p' node_modules/stripe/types/PaymentIntents.d.ts \
   *     | grep -E "^\s{8}[a-z_0-9]+\??: NextAction\."
   *
   * Adding a field here is a deliberate act. Do it if support genuinely needs it to trace a
   * payment — not because a test went red.
   */
  private static readonly NEXT_ACTION_SAFE_FIELDS: ReadonlySet<string> = new Set([
    'type',
    'reference',
    'amount_remaining',
    'currency',
    'expires_at',
    'charge_attempt_at',
    'customer_approval_required',
  ]);

  /**
   * Serializes the event for the commercetools interface interaction, stripping every
   * customer-facing artifact and account detail out of `next_action`.
   *
   * WHY AN ALLOWLIST RATHER THAN REDACTING KNOWN-BAD FIELDS — this is the decision to
   * understand before changing anything here. **The `pspInteraction` is an audit and support
   * record, not a delivery channel.** The buyer already has their URL and their QR code: they
   * receive them from the widget, which reads the PaymentIntent directly from Stripe. Support
   * needs to trace, not to re-deliver. So the record keeps the fields that identify a payment
   * and drops everything that could act on it. Without that sentence, the next person who
   * needs a field will read the allowlist as an oversight instead of a decision.
   *
   * What is being kept out, concretely: `display_bank_transfer_instructions.financial_addresses`
   * (the merchant's full IBAN, sort code, routing number); every `hosted_*_url` and
   * `hosted_voucher_url` (unauthenticated customer-facing links); `boleto_display_details.pdf`
   * and `.number`; the QR payloads of Pix, PayNow, PromptPay, Swish, WeChat and Cash App; and
   * `redirect_to_url.url` — which matters more than it looks, because it embeds a LIVE
   * `payment_intent_client_secret` as a query parameter. Nulling the PaymentIntent's own
   * `client_secret`, which this method also does, would otherwise leave a second working copy
   * of that same secret alive through a different channel.
   *
   * Interface interactions are append-only and readable by every Merchant Center user with
   * payment read access. They cannot be redacted after the fact, which is why this runs before
   * anything is persisted rather than as a cleanup afterwards.
   *
   * DELIBERATE DIVERGENCE FROM THE FIRST VERSION OF THIS METHOD: the bank-transfer-only
   * implementation NULLED `hosted_instructions_url` to preserve the SDK's `string | null`
   * shape. The allowlist DELETES it instead. That is intentional, not an inconsistency between
   * the two commits — shape preservation stopped being achievable once the rule became "keep
   * an explicit set" rather than "blank out three known fields", and an absent key is a
   * stronger signal to a reader than a null one.
   *
   * The deep clone is load-bearing, not stylistic. `event` is read again AFTER `convert()`
   * returns — `applyMulticaptureAdjustment` (stripe-payment.service.ts:1232-1258) reads
   * `capture_method` and `latest_charge` off the same object, and the webhook route logs
   * `event.data.object.id`. Redacting in place would corrupt those reads. Do not "optimize"
   * this into an in-place mutation.
   *
   * This lives here, as a private method, rather than as a shared helper in utils.ts on
   * purpose. The converter is the only thing that builds `pspInteraction` — all three
   * `convert()` call sites (stripe-payment.service.ts:1152, 1374, 1422) flow through it and
   * none re-serializes the raw event — so a private method is a choke point that cannot be
   * bypassed. A public helper inverts the failure mode: someone adds a persistence path and
   * forgets to call it. Please do not "simplify" it into a shared export.
   *
   * NOT A PORT. The composable connector does not do this — its converter only ever handled
   * `display_bank_transfer_instructions`, and its utils.ts merely names the other variants as
   * things its routing predicate must reject. There is no reference implementation to compare
   * against; do not go looking for one.
   *
   * STILL NARROWER THAN THE EVENT. Only `data.object.next_action` is sanitized.
   * `data.previous_attributes` (populated on `*.updated` events) is untouched. So is the
   * Charge side: `Charge.payment_method_details.ach_credit_transfer.{account_number,
   * routing_number}` and `sepa_credit_transfer.iban` carry full PAYER account numbers and
   * arrive on `charge.succeeded`, which DOES write a transaction and DOES persist today —
   * harmless only because this connector configures `customer_balance` exclusively (see
   * bank-transfer-mapper.ts) and `Charge.PaymentMethodDetails.CustomerBalance` is an empty
   * object. And customer PII — `billing_details`, `shipping`, `receipt_email` — is persisted
   * verbatim. This record is NOT PII-free.
   */
  private buildPspInteractionResponse(event: Stripe.Event): string {
    // Read only the discriminator here, and read it as a plain string rather than through a
    // Stripe.PaymentIntent cast — that cast types `object` as the literal 'payment_intent', so
    // comparing it against any other shape is a type error even though the runtime value is
    // whatever Stripe sent.
    const dataObject = event.data.object as { object?: string };
    if (dataObject?.object === 'charge') {
      // Charge-shaped: serialized byte-identically, exactly as before. A Charge has neither
      // `next_action` nor `client_secret`, so there is nothing here for this method to do.
      //
      // NOTE THE POLARITY. This exits early only on the ONE shape positively known to be safe,
      // and lets every other shape fall through the redaction path below. The inverse —
      // `!== 'payment_intent'` — reads equivalently today and fails OPEN tomorrow: Stripe's
      // `SetupIntent` and `Refund` also carry `next_action`, and
      // `SetupIntent.next_action.redirect_to_url.url` embeds a live `setup_intent_client_secret`
      // exactly the way the PaymentIntent variant does. If anyone later adds `setup_intent.*`
      // to the dispatcher — plausible, since `setup_future_usage` and recurring are live in
      // this connector — an `!== 'payment_intent'` guard would hand the whole thing through
      // unsanitized, silently and with no test going red. Written this way that addition is
      // redacted by default and someone has to opt it OUT on purpose.
      //
      // The discriminator is read off `data.object.object` rather than the event type prefix
      // `convert()` uses, because it is the field Stripe itself uses to discriminate and it
      // cannot drift from the payload it describes.
      //
      // The three Charge byte-identity assertions in the converter spec guard this branch
      // against IMPLEMENTATION regressions only. They cannot detect Stripe-side drift: they
      // compare against static fixtures.
      return JSON.stringify(event);
    }

    const redacted = JSON.parse(JSON.stringify(event)) as Stripe.Event;
    const redactedPaymentIntent = redacted.data.object as Stripe.PaymentIntent;
    if (redactedPaymentIntent.next_action) {
      redactedPaymentIntent.next_action = this.sanitizeNextAction(
        redactedPaymentIntent.next_action as unknown as Record<string, unknown>,
      ) as unknown as Stripe.PaymentIntent.NextAction;
    }

    // Nulled on EVERY PaymentIntent-shaped payload, not only when `next_action` is present.
    //
    // WHY UNCONDITIONALLY — **a `client_secret` is a credential, not an identifier.** It has no
    // audit value: the identifier is the PaymentIntent's `id`, and that is kept. There is no
    // support question that is answered by the `client_secret`. If it is worth nothing in the
    // record, then the question "in which states do we keep it?" should not exist.
    //
    // WHY NOT A STATUS CHECK — nulling only for non-terminal statuses was considered and
    // rejected: it fails in the wrong direction. A new non-terminal status that nobody added to
    // the list would store a live secret. That is the same failure shape the `next_action`
    // allowlist above exists to remove; do not "improve" this back into a status check.
    //
    // WHAT THIS FIXES, CONCRETELY: gating on `next_action` meant the nulling protected nothing
    // in practice, because `payment_intent.requires_action` — in practice the only event that
    // arrives carrying a `next_action`, though Stripe's contract does not promise that, so the
    // `next_action` guard above is deliberately not assumed dead — is exactly the one that
    // writes no transaction and is therefore never persisted. Meanwhile
    // `payment_intent.processing` (async settlement in flight) and
    // `payment_intent.payment_failed` (PI returns to `requires_payment_method` so the buyer can
    // retry) both DO persist, and both carry a secret that is still live against Stripe's
    // public client API.
    //
    // This deliberately ends byte-identity for the four persisted PaymentIntent events. That
    // guarantee was a means, not an end — it existed to show we had not changed flows that
    // already worked. Breaking it on purpose, with the assertions updated and the reason
    // recorded, is a different act from breaking it by accident, which is what it guards.
    redactedPaymentIntent.client_secret = null;

    return JSON.stringify(redacted);
  }

  /**
   * Rebuilds a `next_action` subtree keeping only allowlisted scalars.
   *
   * Builds a fresh object rather than deleting from the original: a new object cannot retain a
   * key nobody thought to remove, which is the same fail-closed property the allowlist gives.
   */
  private sanitizeNextAction(node: Record<string, unknown>): Record<string, unknown> {
    // Null-prototype so that a `__proto__` key coming off `JSON.parse` — where it is an own
    // ENUMERABLE property, so `Object.entries` yields it — is assigned as an ordinary own key
    // instead of tripping `Object.prototype`'s `__proto__` setter. Either way nothing leaks and
    // `Object.prototype` is never polluted, but this makes the safety deliberate rather than
    // incidental, and keeps the returned object's prototype standard.
    const clean: Record<string, unknown> = Object.create(null) as Record<string, unknown>;

    for (const [key, value] of Object.entries(node)) {
      if (StripeEventConverter.NEXT_ACTION_SAFE_FIELDS.has(key)) {
        // Allowlisted — but only as a scalar. An allowlisted NAME wrapping an object would
        // otherwise smuggle a whole subtree through if Stripe ever changed one of these fields
        // from a scalar to a structure.
        if (value === null || typeof value !== 'object') {
          clean[key] = value;
        }
        continue;
      }

      // Not allowlisted. Nested objects are recursed so the variant's shape stays legible
      // (`next_action.display_bank_transfer_instructions.reference` survives at its real path).
      // Arrays are dropped whole: inside `next_action` they carry account details, never
      // trace-worthy scalars. Non-allowlisted scalars are dropped.
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        clean[key] = this.sanitizeNextAction(value as Record<string, unknown>);
      }
    }

    return clean;
  }

  private populateTransactions(event: Stripe.Event, paymentIntentId: string): TransactionData[] {
    switch (event.type) {
      case StripeEvent.PAYMENT_INTENT__CANCELED:
        return [
          {
            type: PaymentTransactions.AUTHORIZATION,
            state: PaymentStatus.FAILURE,
            amount: this.populateAmountCanceled(event),
            interactionId: paymentIntentId, //Deprecated but kept for backward compatibility
          },
          {
            type: PaymentTransactions.CANCEL_AUTHORIZATION,
            state: PaymentStatus.SUCCESS,
            amount: this.populateAmountCanceled(event),
            interactionId: paymentIntentId, //Deprecated but kept for backward compatibility
          },
        ];
      case StripeEvent.PAYMENT_INTENT__SUCCEEDED:
        return [
          {
            type: PaymentTransactions.CHARGE,
            state: PaymentStatus.SUCCESS,
            amount: this.populateAmount(event),
            interactionId: paymentIntentId, //Deprecated but kept for backward compatibility
          },
        ];
      case StripeEvent.PAYMENT_INTENT__PROCESSING: {
        // Async methods (e.g. crypto/stablecoin) settle after the intent is confirmed.
        // Model the in-flight state as a pending authorization. amount_received is still 0
        // here, so read the pending amount from `amount`.
        const pi = event.data.object as Stripe.PaymentIntent;
        return [
          {
            type: PaymentTransactions.AUTHORIZATION,
            state: PaymentStatus.PENDING,
            amount: { centAmount: pi.amount, currencyCode: pi.currency.toUpperCase() },
            interactionId: paymentIntentId,
          },
        ];
      }
      case StripeEvent.PAYMENT_INTENT__REQUIRED_ACTION: {
        // Bank transfer awaiting funds: the shopper holds wire instructions and the money is days
        // away, so the in-flight state is modelled as a pending authorization.
        //
        // THIS CASE IS UNCONDITIONAL, AND THE NARROWING LIVES ELSEWHERE. `payment_intent
        // .requires_action` is emitted by card 3DS and Boleto too, and neither must produce a
        // transaction. The route is the gate — `isBankTransferNextAction` decides which
        // requires_action events reach processStripeEvent at all — so by the time one arrives
        // here it is already known to be a bank transfer. Do not re-check the next_action here:
        // two gates that must agree drift, and the route's is the one with the release-gate
        // tests. This case previously returned [] precisely because the route did not narrow.
        //
        // populateAmount() must NOT be reused: it reads `amount_received`, which is 0 until the
        // wire lands, so it would book a 0-cent authorization. `pi.amount` is the full intended
        // amount, taken verbatim as integer cents from Stripe — no arithmetic on this value.
        const pi = event.data.object as Stripe.PaymentIntent;
        return [
          {
            type: PaymentTransactions.AUTHORIZATION,
            state: PaymentStatus.PENDING,
            amount: { centAmount: pi.amount, currencyCode: pi.currency.toUpperCase() },
            interactionId: paymentIntentId,
          },
        ];
      }
      case StripeEvent.PAYMENT_INTENT__PARTIALLY_FUNDED:
        // No commercetools transaction, on purpose. A second Authorization/Pending would break
        // the dedup invariant — a three-instalment top-up would book 3x the order value — and a
        // partial Charge/Success would book revenue that is not on the platform balance, since
        // the funds sit in the customer's cash balance until the transfer completes. The
        // PaymentIntent state has not changed and neither has the commercetools state; only the
        // pspInteraction is persisted, as an audit trail. See ZERO_TRANSACTION_PERSIST_EVENTS in
        // stripe-payment.service.ts, which is what keeps this from being discarded silently.
        return [];
      case StripeEvent.PAYMENT_INTENT__PAYMENT_FAILED:
        return [
          {
            type: PaymentTransactions.AUTHORIZATION,
            state: PaymentStatus.FAILURE,
            amount: this.populateAmount(event),
            interactionId: paymentIntentId, //Deprecated but kept for backward compatibility
          },
        ];
      case StripeEvent.CHARGE__REFUNDED: {
        return [
          {
            type: PaymentTransactions.REFUND,
            state: PaymentStatus.SUCCESS,
            amount: this.populateAmount(event),
            interactionId: paymentIntentId, //Deprecated but kept for backward compatibility
          },
          {
            type: PaymentTransactions.CHARGE_BACK,
            state: PaymentStatus.SUCCESS,
            amount: this.populateAmount(event),
            interactionId: paymentIntentId, //Deprecated but kept for backward compatibility
          },
        ];
      }
      case StripeEvent.CHARGE__SUCCEEDED: {
        return [
          {
            type: PaymentTransactions.AUTHORIZATION,
            state: PaymentStatus.SUCCESS,
            amount: this.populateAmount(event),
            interactionId: paymentIntentId, //Deprecated but kept for backward compatibility
          },
        ];
      }
      case StripeEvent.CHARGE__UPDATED:
        return [
          {
            type: PaymentTransactions.CHARGE,
            state: PaymentStatus.SUCCESS,
            amount: this.populateAmount(event),
            interactionId: paymentIntentId, //Deprecated but kept for backward compatibility
          },
        ];
      default: {
        const error = `Unsupported event ${event.type}`;
        throw wrapStripeError(new Error(error));
      }
    }
  }

  private populateAmount(opts: Stripe.Event): Money {
    let data, centAmount;
    if (opts.type.startsWith('payment')) {
      data = opts.data.object as Stripe.PaymentIntent;
      centAmount = data.amount_received;
    } else {
      data = opts.data.object as Stripe.Charge;
      centAmount = data.amount_refunded;
    }

    return {
      centAmount: centAmount,
      currencyCode: data.currency.toUpperCase(),
    };
  }

  private populateAmountCanceled(opts: Stripe.Event): Money {
    const data = opts.data.object as Stripe.PaymentIntent;
    const currencyCode = data.currency.toUpperCase();
    const centAmount = data.amount;

    return {
      centAmount: centAmount,
      currencyCode: currencyCode,
    };
  }

  private getCtPaymentId(event: Stripe.PaymentIntent | Stripe.Charge): string {
    return event.metadata.ct_payment_id;
  }
}
