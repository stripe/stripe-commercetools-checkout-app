import Stripe from 'stripe';
import {
  Address,
  Cart,
  ErrorInvalidOperation,
  ErrorResourceNotFound,
  healthCheckCommercetoolsPermissions,
  PaymentMethod,
  statusHandler,
} from '@commercetools/connect-payments-sdk';
import { Customer, Order, Payment, PaymentDraft } from '@commercetools/platform-sdk';
import {
  CancelPaymentRequest,
  CapturePaymentRequest,
  ConfigResponse,
  PaymentProviderModificationResponse,
  RefundPaymentRequest,
  ReversePaymentRequest,
  StatusResponse,
} from './types/operation.type';

import { SupportedPaymentComponentsSchemaDTO } from '../dtos/operations/payment-componets.dto';
import { PaymentModificationStatus, PaymentTransactions } from '../dtos/operations/payment-intents.dto';
import packageJSON from '../../package.json';

import { AbstractPaymentService } from './abstract-payment.service';
import { config, getConfig } from '../config/config';
import { appLogger, paymentSDK } from '../payment-sdk';
import {
  CaptureMethod,
  OrderPaymentState,
  PaymentStatus,
  StripeEvent,
  StripeEventUpdatePayment,
  StripePaymentServiceOptions,
} from './types/stripe-payment.type';
import {
  CollectBillingAddressOptions,
  ConfigElementResponseSchemaDTO,
  CustomerResponseSchemaDTO,
  GetExpressPaymentDataResponseSchemaDTO,
  PaymentOutcome,
  PaymentResponseSchemaDTO,
} from '../dtos/stripe-payment.dto';
import {
  getCartIdFromContext,
  getCheckoutTransactionItemIdFromContext,
  getMerchantReturnUrlFromContext,
} from '../libs/fastify/context/context';
import { stripeApi, wrapStripeError } from '../clients/stripe.client';
import { log } from '../libs/logger';
import crypto from 'crypto';
import { StripeEventConverter } from './converters/stripeEventConverter';
import { stripeCustomerIdCustomType, stripeCustomerIdFieldName } from '../custom-types/custom-types';
import { getCustomFieldUpdateActions } from '../services/commerce-tools/customTypeHelper';
import {
  isBankTransferNextAction,
  isValidUUID,
  ORDER_PAYMENT_STATE_BY_EVENT,
  parsePaymentElementOptions,
  shouldTransitionOrderPaymentState,
} from '../utils';
import { PaymentBehaviorRule, resolvePaymentBehaviorWithSteeringCheck } from './payment-behavior-resolver';
import { EuBankTransferCountry, getBankTransferOptions, resolveRailSuppression } from '../mappers/bank-transfer-mapper';
import { updateCustomerById } from '../services/commerce-tools/customerClient';
import { CT_CUSTOM_FIELD_TAX_CALCULATIONS } from '../constants';

/**
 * Events whose commercetools write must NOT be swallowed.
 *
 * Both write the Pending authorization that an async settlement depends on — crypto via
 * `payment_intent.processing`, bank transfer via `payment_intent.requires_action`. Losing that
 * write leaves the payment with no record of the in-flight authorization while the money is
 * genuinely on its way, so the webhook answers non-2xx and Stripe retries (KI-001). The dedup
 * guard below is what makes the retry safe.
 *
 * `payment_intent.partially_funded` is deliberately NOT a member: it writes no transaction, so a
 * lost event costs an audit line rather than correctness, and re-throwing would cause a retry
 * storm on an event that fires once per instalment.
 */
const ASYNC_PENDING_EVENTS: readonly StripeEvent[] = [
  StripeEvent.PAYMENT_INTENT__PROCESSING,
  StripeEvent.PAYMENT_INTENT__REQUIRED_ACTION,
];

/**
 * Events that must still persist their interface interaction when the converter produces no
 * transaction, so the event leaves an audit trail instead of being silently discarded.
 *
 * `charge.succeeded` is a member of the sibling connector's equivalent list and is deliberately
 * NOT here: this connector's converter returns an Authorization/Success for `charge.succeeded`, so
 * it never reaches the zero-transaction branch at all. Adding it would be dead code that also
 * drags in the sibling's Initial→Success promotion, which this connector does not perform.
 */
const ZERO_TRANSACTION_PERSIST_EVENTS: readonly StripeEvent[] = [StripeEvent.PAYMENT_INTENT__PARTIALLY_FUNDED];

/**
 * Waits between order-lookup attempts when reflecting a `Pending` order paymentState.
 *
 * NOT A RACE — A GUARANTEED ORDERING WITH VARIABLE LAG. `payment_intent.requires_action` always
 * fires before commercetools Checkout creates the order, because CT creates it when the shopper
 * completes checkout, which is necessarily after the PaymentIntent is confirmed. So the first lookup
 * ALWAYS loses; the only question is by how much. Calling it a race invites 50/50 reasoning and the
 * wrong sizing.
 *
 * Measured lag, `requires_action` → order created (bank-transfer rail, dev deployment):
 *
 * | run | lag |
 * |---|---|
 * | 2026-08-18 02:41:19 | 0.88 s |
 * | 2026-08-18 23:12:58 | **3.8 s** |
 *
 * The first version of this constant was `[500, 1500]`, sized off the 0.88 s sample alone. The
 * second run missed by **425 ms** — the last attempt landed at 23:13:01.357 and the order appeared at
 * 23:13:01.782. Sizing a window from n=1 is the same mistake as generalizing a single probe; the
 * schedule below has n=2 and roughly 3x headroom over the worse sample, which is still an empirical
 * bound and not a guarantee.
 *
 * Cost of being wrong in each direction is asymmetric, which is why the headroom is generous:
 * - Too short → the `Pending` write is lost. Recoverable at settlement via ownership signal 2, so a
 *   paid order still reaches `Paid`. But an ABANDONED transfer emits no further event, so its order
 *   stays unset forever — indistinguishable from a card order that never got a webhook, which is the
 *   ambiguity this whole feature exists to remove.
 * - Too long → added webhook latency, but only on the branch where the order genuinely is not there
 *   yet. This route answers 200 only after processing, so it is real latency; ~11 s worst case sits
 *   well inside Stripe's delivery timeout.
 */
const ORDER_LOOKUP_RETRY_DELAYS_MS: readonly number[] = [500, 1500, 3000, 6000];

/**
 * Detects a commercetools optimistic-locking conflict across the shapes it can arrive in.
 *
 * The raw platform-sdk client rejects with an error carrying `statusCode` (sometimes only on
 * `body.statusCode`) and a `ConcurrentModification` code in `body.errors[]` — it does NOT throw the
 * SDK's typed `ErrorConcurrentModification`, which only wraps failures raised through
 * connect-payments-sdk's own services. Checking both the numeric status and the error code means
 * neither a shape change nor a status-only response silently turns a retryable conflict into a
 * swallowed warning.
 */
const isConcurrentModification = (error: unknown): boolean => {
  const err = error as {
    statusCode?: number;
    code?: string;
    body?: { statusCode?: number; errors?: Array<{ code?: string }> };
  };
  const status = err?.statusCode ?? err?.body?.statusCode;
  if (status === 409) {
    return true;
  }
  return (
    err?.code === 'ConcurrentModification' ||
    (err?.body?.errors ?? []).some((e) => e?.code === 'ConcurrentModification')
  );
};

export class StripePaymentService extends AbstractPaymentService {
  private stripeEventConverter: StripeEventConverter;

  constructor(opts: StripePaymentServiceOptions) {
    super(
      opts.ctCartService,
      opts.ctPaymentService,
      opts.ctOrderService,
      opts.ctPaymentMethodService,
      opts.ctRecurringPaymentJobService,
    );
    this.stripeEventConverter = new StripeEventConverter();
  }

  /**
   * Get configurations
   *
   * @remarks
   * Implementation to provide mocking configuration information
   *
   * @returns Promise with mocking object containing configuration information
   */
  public async config(): Promise<ConfigResponse> {
    const config = getConfig();
    return {
      environment: config.mockEnvironment,
      publishableKey: config.stripePublishableKey,
      captureMethod: config.stripeCaptureMethod as 'automatic' | 'automatic_async' | 'manual',
      ...(config.stripePaymentElementAppearance && { appearance: config.stripePaymentElementAppearance }),
      ...(config.stripeExpressElementOptions && { expressElementOptions: config.stripeExpressElementOptions }),
    };
  }

  /**
   * Get status
   *
   * @remarks
   * Implementation to provide mocking status of external systems
   *
   * @returns Promise with mocking data containing a list of status from different external systems
   */
  public async status(): Promise<StatusResponse> {
    const handler = await statusHandler({
      timeout: getConfig().healthCheckTimeout,
      log: appLogger,
      checks: [
        healthCheckCommercetoolsPermissions({
          requiredPermissions: [
            'manage_payments',
            'view_sessions',
            'view_api_clients',
            'manage_orders',
            'introspect_oauth_tokens',
            'manage_checkout_payment_intents',
            'manage_types',
            'manage_payment_methods',
            'manage_recurring_payment_jobs',
          ],
          ctAuthorizationService: paymentSDK.ctAuthorizationService,
          projectKey: getConfig().projectKey,
        }),
        async () => {
          try {
            const paymentMethods = await stripeApi().paymentMethods.list({
              limit: 3,
            });
            return {
              name: 'Stripe Status check',
              status: 'UP',
              message: 'Stripe api is working',
              details: {
                paymentMethods,
              },
            };
          } catch (e) {
            return {
              name: 'Stripe Status check',
              status: 'DOWN',
              message: 'The mock paymentAPI is down for some reason. Please check the logs for more details.',
              details: {
                error: e,
              },
            };
          }
        },
      ],
      metadataFn: async () => ({
        name: packageJSON.name,
        description: packageJSON.description,
        '@commercetools/connect-payments-sdk': packageJSON.dependencies['@commercetools/connect-payments-sdk'],
        stripe: packageJSON.dependencies['stripe'],
      }),
    })();

    return handler.body;
  }

  /**
   * Get supported payment components
   *
   * @remarks
   * Implementation to provide the mocking payment components supported by the processor.
   *
   * @returns Promise with mocking data containing a list of supported payment components
   */
  public async getSupportedPaymentComponents(): Promise<SupportedPaymentComponentsSchemaDTO> {
    return {
      dropins: [
        {
          type: 'embedded',
        },
      ],
      components: [],
      express: [
        {
          type: 'dropin',
        },
      ],
    };
  }

  /**
   * Capture payment in Stripe, supporting multicapture (multiple partial captures).
   *
   * @remarks
   * Supports capturing the total or a partial amount multiple times, as allowed by Stripe.
   * Partial captures are only allowed when STRIPE_ENABLE_MULTI_OPERATIONS is enabled.
   *
   * @param {CapturePaymentRequest} request - Information about the ct payment and the amount.
   * @returns Promise with data containing operation status and PSP reference
   */
  public async capturePayment(request: CapturePaymentRequest): Promise<PaymentProviderModificationResponse> {
    try {
      const config = getConfig();
      const paymentIntentId = request.payment.interfaceId as string;
      const amountToBeCaptured = request.amount.centAmount;
      const stripePaymentIntent: Stripe.PaymentIntent = await stripeApi().paymentIntents.retrieve(paymentIntentId);

      if (!request.payment.amountPlanned.centAmount) {
        throw new Error('Payment amount is not set');
      }

      const cartTotalAmount = request.payment.amountPlanned.centAmount;
      const isPartialCapture = stripePaymentIntent.amount_received + amountToBeCaptured < cartTotalAmount;

      // Check if partial capture is attempted without multicapture enabled
      if (isPartialCapture && !config.stripeEnableMultiOperations) {
        log.error('Partial capture attempted without STRIPE_ENABLE_MULTI_OPERATIONS enabled', {
          paymentId: paymentIntentId,
          amountToBeCaptured,
          amountReceived: stripePaymentIntent.amount_received,
          cartTotalAmount,
        });
        throw new Error(
          'Partial captures require STRIPE_ENABLE_MULTI_OPERATIONS=true and multicapture support in your Stripe account',
        );
      }

      const response = await stripeApi().paymentIntents.capture(paymentIntentId, {
        amount_to_capture: amountToBeCaptured,
        ...(isPartialCapture &&
          config.stripeEnableMultiOperations && {
            final_capture: false,
          }),
      });

      log.info(`Payment modification completed.`, {
        paymentId: paymentIntentId,
        action: PaymentTransactions.CHARGE,
        result: PaymentModificationStatus.APPROVED,
        trackingId: response.id,
        isPartialCapture: isPartialCapture,
        multiOperationsEnabled: config.stripeEnableMultiOperations,
      });

      return {
        outcome: PaymentModificationStatus.APPROVED,
        pspReference: response.id,
      };
    } catch (error) {
      log.error('Error capturing payment in Stripe', { error });
      return {
        outcome: PaymentModificationStatus.REJECTED,
        pspReference: request.payment.interfaceId as string,
      };
    }
  }

  /**
   * Cancel payment in Stripe.
   *
   * @param {CancelPaymentRequest} request - contains amount and {@link https://docs.commercetools.com/api/projects/payments | Payment } defined in composable commerce
   * @returns Promise with mocking data containing operation status and PSP reference
   */
  public async cancelPayment(request: CancelPaymentRequest): Promise<PaymentProviderModificationResponse> {
    try {
      const paymentIntentId = request.payment.interfaceId as string;
      const response = await stripeApi().paymentIntents.cancel(paymentIntentId);

      log.info(`Payment modification completed.`, {
        paymentId: paymentIntentId,
        action: PaymentTransactions.CANCEL_AUTHORIZATION,
        result: PaymentModificationStatus.APPROVED,
        trackingId: response.id,
      });

      return { outcome: PaymentModificationStatus.APPROVED, pspReference: response.id };
    } catch (error) {
      log.error('Error canceling payment in Stripe', { error });
      return {
        outcome: PaymentModificationStatus.REJECTED,
        pspReference: request.payment.interfaceId as string,
      };
    }
  }

  /**
   * Refund payment in Stripe.
   *
   * @remarks
   * Creates a refund in Stripe. When STRIPE_ENABLE_MULTI_OPERATIONS is disabled,
   * webhook-based refund tracking may be limited. Enable the feature flag for
   * full multirefund support.
   *
   * @param {RefundPaymentRequest} request - contains amount and {@link https://docs.commercetools.com/api/projects/payments | Payment } defined in composable commerce
   * @returns Promise with mocking data containing operation status and PSP reference
   */
  public async refundPayment(request: RefundPaymentRequest): Promise<PaymentProviderModificationResponse> {
    try {
      const config = getConfig();
      const paymentIntentId = request.payment.interfaceId as string;
      const amount = request.amount.centAmount;

      // Check if there are existing successful refunds
      const existingRefunds = this.ctPaymentService.hasTransactionInState({
        payment: request.payment,
        transactionType: 'Refund',
        states: ['Success'],
      });

      // Warn if multiple refunds attempted without feature enabled
      if (existingRefunds && !config.stripeEnableMultiOperations) {
        log.warn('Multiple refunds attempted without STRIPE_ENABLE_MULTI_OPERATIONS enabled', {
          paymentId: request.payment.id,
          paymentIntentId,
          amount,
          note: 'Webhook-based refund tracking may not work properly. Consider enabling STRIPE_ENABLE_MULTI_OPERATIONS.',
        });
      }

      // Refund ids already recorded against this payment, captured BEFORE the create so the
      // comparison below is against prior state. Only `re_...` values land here; see the coverage
      // gap noted in the collapse branch.
      const recordedRefundIds = new Set(
        (request.payment.transactions ?? [])
          .filter((tx) => tx.type === 'Refund')
          .map((tx) => tx.interactionId)
          .filter((id): id is string => Boolean(id)),
      );

      // metadata: stamps the commercetools payment id onto the Refund object itself.
      //
      // A Stripe Refund does NOT inherit the PaymentIntent's metadata — composable measured a
      // `refund.updated` payload arriving with `metadata: {}`. This stamp stopped being merely
      // forward-compatible on 2026-08-13: `refund.updated` / `refund.failed` are now registered
      // (connectors/actions.ts) and `processStripeEventRefundFailed` reads exactly this field to
      // decide which commercetools payment to correct. It is the ONLY link between a failed refund
      // and its payment, because getCtPaymentId is reached only for PaymentIntent- and
      // Charge-shaped payloads and a Refund is neither.
      //
      // A refund issued from the Stripe Dashboard still will not carry it, and that path is
      // therefore uncorrectable — logged and skipped, never guessed.
      //
      // idempotencyKey: refunds.create was the only write on a money-returning path without one,
      // and for refunds that difference is money — a retried commercetools refundPayment (client
      // retry, proxy replay, redelivery) issued a SECOND real refund. It is not the only Stripe
      // write in this service lacking a key: capture and cancel still have none (KI-007).
      //
      // WHY THERE IS NO SEQUENCE NUMBER IN THIS KEY. The sibling connector keys on
      // `refund-{id}-{amount}-{refundSequence}`, counting Refund transactions already on the
      // payment. That is deliberately NOT ported, because ANY SEQUENCE DERIVED FROM OBSERVED STATE
      // INCREMENTS ONCE THE FIRST REFUND SUCCEEDS, so a retry can never reproduce the original key:
      // the caller's response is lost, `charge.refunded` has meanwhile written the transaction, the
      // retry computes seq+1, and a second real refund goes out. It protects only the window before
      // the webhook lands — the window in which retries are least likely.
      //
      // COUNTING FROM STRIPE INSTEAD (`refunds.list`) DOES NOT FIX THIS, and it is the natural next
      // idea, so: the retry would also observe one existing refund and compute 1. The observation is
      // what moved, not where it was read from. Only the caller knows whether a call is a retry, and
      // `merchantReference` is optional on RefundPaymentRequest.
      //
      // THE HUB IDEMPOTENCY RULE IS SATISFIED ONLY IN PART, stated plainly rather than implied:
      // `payment.id` is the platform-entity-derived component. `amount` is a DISCRIMINATOR — it is
      // caller-supplied, and AmountSchema (Type.Integer()) validates neither positivity nor a
      // ceiling against the captured amount, so Stripe is the sole cap. Varying it by one cent
      // yields a fresh key and bypasses the dedupe entirely.
      const response = await stripeApi().refunds.create(
        {
          payment_intent: paymentIntentId,
          amount: amount,
          metadata: { ct_payment_id: request.payment.id },
        },
        { idempotencyKey: `refund-${request.payment.id}-${amount}` },
      );

      // Stripe replayed an existing refund instead of creating one — verified against the live API:
      // a repeated idempotency key returns the ORIGINAL object, same id, same `created`.
      //
      // TWO DIFFERENT SITUATIONS REACH HERE AND `REJECTED` DOES NOT MEAN THE SAME THING IN EACH.
      // They are indistinguishable from inside the connector; do not add a heuristic that pretends
      // otherwise.
      //
      //   1. A RETRY of the same refund, after the first HTTP response was lost. The refund DID
      //      happen. `REJECTED` is true of THIS CALL only — it must not be read as "the refund
      //      failed", because it did not.
      //   2. TWO legitimate partial refunds of equal amount inside Stripe's 24h key window. The
      //      second did NOT happen. Here `REJECTED` is correct without qualification.
      //
      // `pspReference` carries the existing refund id ON PURPOSE, not incidentally: it is what lets
      // the caller reconcile and discover that in case 1 the refund already exists, rather than
      // concluding nothing happened and refunding a second time by hand.
      //
      // But note what it is NOT: per KI-002 the REJECTED path writes nothing to commercetools — no
      // transaction, no state update — so this id reaches only the HTTP response body, which in
      // case 1 is precisely the response that went missing. THE DURABLE ARTIFACT IS THE log.error
      // BELOW, not pspReference. Do not treat the return value as the record.
      //
      // TWO COVERAGE GAPS, and the second is the mirror image of the criticism levelled at the
      // sibling connector's sequence key above — stated plainly rather than left for a reader to
      // notice:
      //
      //   a. TIMING. `recordedRefundIds` is populated only once `charge.refunded` has been
      //      processed. The likeliest retry of all — a client or proxy replay seconds after a lost
      //      response — arrives before that, sees an empty set, and returns RECEIVED. So this
      //      branch will rarely fire for case 1.
      //   b. MULTI-OPERATIONS. With STRIPE_ENABLE_MULTI_OPERATIONS disabled the refund handler
      //      writes `interactionId = paymentIntentId` rather than the refund id, so no `re_...`
      //      value is ever recorded and the branch cannot fire at all.
      //
      // Neither is a loss of money: the idempotency key itself is what prevents the duplicate
      // refund, and both gaps fail in the SAFE direction — never a false REJECTED, since `re_` and
      // `pi_` ids cannot collide. They are missing DETECTION, not missing protection. Closing them
      // needs the `Idempotent-Replayed` response header, queued separately because it could not be
      // verified here.
      if (recordedRefundIds.has(response.id)) {
        log.error(
          'Refund collapsed by idempotency: Stripe replayed an existing refund and no NEW money was returned. ' +
            'Read this two ways before acting — either this call was a retry and the original refund DID go out ' +
            '(check the referenced refund before issuing another), or a second equal-amount refund was requested ' +
            'inside the 24h key window and did not happen.',
          {
            paymentId: request.payment.id,
            existingRefundId: response.id,
            amount,
          },
        );

        return { outcome: PaymentModificationStatus.REJECTED, pspReference: response.id };
      }

      log.info(`Payment modification completed.`, {
        paymentId: request.payment.id,
        action: PaymentTransactions.REFUND,
        result: PaymentModificationStatus.APPROVED,
        trackingId: response.id,
        multiOperationsEnabled: config.stripeEnableMultiOperations,
        isMultipleRefund: existingRefunds,
      });

      return { outcome: PaymentModificationStatus.RECEIVED, pspReference: response.id };
    } catch (error) {
      log.error('Error refunding payment in Stripe', { error });
      return {
        outcome: PaymentModificationStatus.REJECTED,
        pspReference: request.payment.interfaceId as string,
      };
    }
  }

  /**
   * Reverse payment
   *
   * @remarks
   * Abstract method to execute payment reversals in support of automated reversals to be triggered by checkout api. The actual invocation to PSPs should be implemented in subclasses
   *
   * @param request
   * @returns Promise with outcome containing operation status and PSP reference
   */
  public async reversePayment(request: ReversePaymentRequest): Promise<PaymentProviderModificationResponse> {
    const hasCharge = this.ctPaymentService.hasTransactionInState({
      payment: request.payment,
      transactionType: 'Charge',
      states: ['Success'],
    });
    const hasRefund = this.ctPaymentService.hasTransactionInState({
      payment: request.payment,
      transactionType: 'Refund',
      states: ['Success', 'Pending'],
    });
    const hasCancelAuthorization = this.ctPaymentService.hasTransactionInState({
      payment: request.payment,
      transactionType: 'CancelAuthorization',
      states: ['Success', 'Pending'],
    });

    const wasPaymentReverted = hasRefund || hasCancelAuthorization;

    if (hasCharge && !wasPaymentReverted) {
      return this.refundPayment({
        payment: request.payment,
        merchantReference: request.merchantReference,
        amount: request.payment.amountPlanned,
      });
    }

    const hasAuthorization = this.ctPaymentService.hasTransactionInState({
      payment: request.payment,
      transactionType: 'Authorization',
      states: ['Success'],
    });
    if (hasAuthorization && !wasPaymentReverted) {
      return this.cancelPayment({ payment: request.payment });
    }

    throw new ErrorInvalidOperation('There is no successful payment transaction to reverse.');
  }

  /**
   * Validates if the customer exists in Stripe and creates a new customer if it does not exist, to create a session
   * for the Stripe customer.
   * @returns Promise with the stripeCustomerId, ephemeralKey and sessionId.
   */
  public async getCustomerSession(): Promise<CustomerResponseSchemaDTO | undefined> {
    try {
      const cart = await this.ctCartService.getCart({ id: getCartIdFromContext() });
      const ctCustomerId = cart.customerId;
      if (!ctCustomerId) {
        log.warn('Cart does not have a customerId - Skipping customer creation');
        return;
      }

      const customer = await this.getCtCustomer(ctCustomerId);
      if (!customer) {
        log.info('Customer not found - Skipping Stripe Customer creation');
        return;
      }

      const stripeCustomerId = await this.retrieveOrCreateStripeCustomerId(cart, customer);
      if (!stripeCustomerId) {
        throw 'Failed to get stripe customer id.';
      }

      const ephemeralKey = await this.createEphemeralKey(stripeCustomerId);
      if (!ephemeralKey) {
        throw 'Failed to create ephemeral key.';
      }

      const session = await this.createSession(stripeCustomerId, cart);
      if (!session) {
        throw 'Failed to create session.';
      }

      return {
        stripeCustomerId,
        ephemeralKey: ephemeralKey,
        sessionId: session.client_secret,
      };
    } catch (error) {
      throw wrapStripeError(error);
    }
  }

  /**
   * Determines the setup_future_usage value for PaymentIntent creation based on configurations.
   * Combines override functionality with recurring cart support.
   *
   * Priority order:
   * 1. Recurring cart check (recurring carts always use 'off_session' regardless of override)
   * 2. Override value (if configured and valid)
   * 3. Default config value
   *
   * @param cart Optional cart to check for recurring status
   * @returns The setup_future_usage value to use in PaymentIntent, or undefined to not include it
   */
  private getPaymentIntentSetupFutureUsage(
    cart?: Cart,
    behaviorSetupFutureUsage?: string,
  ): Stripe.PaymentIntentCreateParams.SetupFutureUsage | undefined {
    const config = getConfig();

    // Priority 1: Recurring carts always require 'off_session' for future charges
    // This ensures consistency with Customer Session configuration and recurring order requirements
    if (cart && (this.ctCartService as any).isRecurringCart?.(cart)) {
      log.info('Recurring cart detected: forcing setup_future_usage to off_session for recurring order compatibility');
      return 'off_session';
    }

    // Priority 2: Per-cart behavior rule overrides the flat env var when provided.
    // Log a warning when the behavior rule downgrades an off_session global config.
    const flatEnvValue = config.stripePaymentIntentSetupFutureUsage;
    const overrideValue = behaviorSetupFutureUsage !== undefined ? behaviorSetupFutureUsage : flatEnvValue;

    if (
      behaviorSetupFutureUsage !== undefined &&
      flatEnvValue?.trim().toLowerCase() === 'off_session' &&
      (behaviorSetupFutureUsage.trim() === '' ||
        ['none', 'null', 'undefined'].includes(behaviorSetupFutureUsage.trim().toLowerCase()))
    ) {
      log.warn(
        'STRIPE_PAYMENT_BEHAVIOR_RULES overrides setupFutureUsage to empty while global config is off_session. ' +
          'Subscription eligibility may be broken for matched carts.',
        {
          globalSetupFutureUsage: flatEnvValue,
          behaviorSetupFutureUsage,
        },
      );
    }

    // Priority 3: If override is configured, process it
    if (overrideValue !== undefined) {
      // Normalize the value (trim and lowercase for comparison)
      const normalizedValue = overrideValue.trim().toLowerCase();

      // Empty string, 'none', 'null', or 'undefined' means don't include setup_future_usage
      if (
        normalizedValue === '' ||
        normalizedValue === 'none' ||
        normalizedValue === 'null' ||
        normalizedValue === 'undefined'
      ) {
        log.info('PaymentIntent setup_future_usage is disabled by configuration');
        return undefined;
      }

      // Return the override value if it's a valid option
      if (normalizedValue === 'off_session' || normalizedValue === 'on_session') {
        return normalizedValue as Stripe.PaymentIntentCreateParams.SetupFutureUsage;
      }

      // Invalid value: log warning and continue to default
      log.warn('Invalid STRIPE_PAYMENT_INTENT_SETUP_FUTURE_USAGE value, using default behavior', {
        value: overrideValue,
        validValues: ['', 'none', 'null', 'undefined', 'off_session', 'on_session'],
      });
    }

    // Priority 4: Fall back to default config value
    return config.stripeSavedPaymentMethodConfig?.payment_method_save_usage as
      | Stripe.PaymentIntentCreateParams.SetupFutureUsage
      | undefined;
  }

  /**
   * Creates a payment intent using the Stripe API and create commercetools payment with Initial transaction.
   *
   * @param expressCheckout When true, shipping is omitted on the PaymentIntent so the Express Checkout Element can set it at confirm (default false).
   * @return Promise<PaymentResponseSchemaDTO> A Promise that resolves to a PaymentResponseSchemaDTO object containing the client secret and payment reference.
   */
  public async createPaymentIntentStripe(
    expressCheckout = false,
    expressCustomerSession = false,
  ): Promise<PaymentResponseSchemaDTO> {
    const config = getConfig();
    const ctCart = await this.ctCartService.getCart({ id: getCartIdFromContext() });

    // Resolve per-cart behavior rule (if STRIPE_PAYMENT_BEHAVIOR_RULES is configured).
    //
    // ALL FIVE FIELDS resolve through the trusted path — cart.country and cart.store.key only. Until
    // 2026-08-13 only euBankTransferCountry did, and the other four still accepted
    // cart.billingAddress.country / cart.shippingAddress.country, which are shopper-supplied (the
    // express enabler writes the shopper's own address to the cart). That was not merely untidy:
    // steering captureMethod to 'manual' in a market whose default is 'automatic' produces an
    // authorization-only PaymentIntent, and CT Checkout treats Authorization:Success as paid — the
    // order ships while the authorization expires uncaptured. There is no untrusted rule object here
    // any more, deliberately, so no field can quietly go back to being resolved the other way.
    const { rule: behaviorRule, steeredFields } = resolvePaymentBehaviorWithSteeringCheck(
      config.stripePaymentBehaviorRules,
      ctCart,
    );
    const euBankTransferCountry = behaviorRule?.euBankTransferCountry;

    if (behaviorRule || steeredFields.length > 0) {
      log.info('Resolved per-cart payment behavior rule.', {
        cartId: ctCart.id,
        // FIELD NAMES, not the rule object. A whole-object spread silently logs every field later
        // added to PaymentBehaviorRule, which is what 2026-08-07-013 was raised for.
        ruleFields: Object.keys(behaviorRule ?? {}),
        // The one VALUE that is safe to log: DE/FR/IE/NL, validated against EU_BANK_TRANSFER_COUNTRIES
        // at startup, and merchant configuration rather than shopper data.
        trustedEuBankTransferCountry: euBankTransferCountry,
        // What must NEVER be logged is the DISCRIMINATOR that selected a rule —
        // cart.billingAddress.country and cart.shippingAddress.country are the shopper's own address,
        // and this line already carries cartId, which resolves to an identified customer. Hence names
        // only. See resolvePaymentBehaviorWithSteeringCheck for why this signal is one-directional.
        steeredFields,
      });
    }

    const customer = await this.getCtCustomer(ctCart.customerId!);
    const shippingAddress = this.getStripeCustomerAddress(ctCart.shippingAddress, customer?.addresses[0]);
    const amountPlanned = await this.ctCartService.getPaymentAmount({ cart: ctCart });
    const captureMethodConfig = behaviorRule?.captureMethod ?? config.stripeCaptureMethod;
    const merchantReturnUrl = getMerchantReturnUrlFromContext() || config.merchantReturnUrl;
    const setupFutureUsage = this.getPaymentIntentSetupFutureUsage(ctCart, behaviorRule?.setupFutureUsage);
    const effectiveFlowType = behaviorRule?.flowType ?? config.stripePaymentFlow;
    const effectiveSetupFutureUsage = this.applyPiFirstOverride(effectiveFlowType, setupFutureUsage);
    // Runtime half of the bank-transfer rail-suppression warning. Fires ONLY when it actually bites:
    // this cart resolved an IBAN country, the currency qualifies, and the PaymentIntent's own
    // effective configuration guarantees Stripe will drop customer_balance anyway. Because it is
    // silent in the healthy case, its mere presence in a log is the diagnosis.
    //
    // WHY THIS EXISTS ALONGSIDE THE STARTUP WARNING IN config.ts — they cover disjoint cases, so
    // neither is redundant. `setup_future_usage` has four sources that override each other:
    //   1. recurring cart      -> forces 'off_session'   <-- ONLY visible here, it depends on the cart
    //   2. the market's rule   -> behaviorRule.setupFutureUsage
    //   3. the flat env var    -> STRIPE_PAYMENT_INTENT_SETUP_FUTURE_USAGE
    //   4. flowType 'pi_first' -> strips it, which UN-suppresses the rail
    // Startup sees 2, 3 and 4 and warns at deploy time, in front of whoever wrote the config.
    // Only this site sees 1.
    //
    // THIS LOG MUST NOT NAME THE MARKET, and that asymmetry with the startup warning is deliberate.
    // A market key can be resolved from cart.billingAddress.country / shippingAddress.country — the
    // shopper's own address, which the express enabler writes to the cart — and this line already
    // carries cartId, which resolves to an identified customer. Booleans and field names only, the
    // same stance the adjacent behavior-rule log takes. config.ts may name it because it iterates
    // the merchant's own configuration map, where no shopper data exists.
    const railSuppression = euBankTransferCountry
      ? resolveRailSuppression({
          setupFutureUsage: effectiveSetupFutureUsage,
          captureMethod: captureMethodConfig,
        })
      : [];
    if (railSuppression.length > 0 && amountPlanned.currencyCode.toLowerCase() === 'eur') {
      log.warn(
        'Bank transfer options were sent but Stripe will suppress the rail for this PaymentIntent. ' +
          'The customer_balance tab will not render. See STRIPE_PAYMENT_BEHAVIOR_RULES for this market.',
        {
          cartId: ctCart.id,
          suppressedBySetupFutureUsage: railSuppression.includes('setupFutureUsage'),
          suppressedByCaptureMethod: railSuppression.includes('captureMethod'),
        },
      );
    }

    const stripeCustomerId = customer?.custom?.fields?.[stripeCustomerIdFieldName];
    const expressWithCustomer = this.resolveExpressWithCustomer(
      expressCheckout,
      stripeCustomerId,
      expressCustomerSession,
    );

    // Tax calculation integration
    const taxCalculationReferences = ctCart.custom?.fields?.[CT_CUSTOM_FIELD_TAX_CALCULATIONS] as string[] | undefined;
    const taxCalculationCount = taxCalculationReferences?.length ?? 0;
    const hasSingleTaxCalculation = taxCalculationCount === 1;
    const hasTaxCalculations = taxCalculationCount > 0;

    let paymentIntent!: Stripe.PaymentIntent;

    try {
      const idempotencyKey = crypto.randomUUID();
      const createParams = this.buildPaymentIntentCreateParams({
        ctCart,
        amountPlanned,
        expressCheckout,
        expressWithCustomer,
        shippingAddress,
        stripeCustomerId,
        setupFutureUsage: effectiveSetupFutureUsage,
        captureMethod: captureMethodConfig as CaptureMethod,
        projectKey: config.projectKey,
        stripeEnableMultiOperations: config.stripeEnableMultiOperations,
        hasSingleTaxCalculation,
        taxCalculationReference: hasSingleTaxCalculation ? taxCalculationReferences![0] : undefined,
        euBankTransferCountry,
      });
      paymentIntent = await stripeApi().paymentIntents.create(createParams, {
        idempotencyKey,
      });
    } catch (e) {
      throw wrapStripeError(e);
    }

    log.info(`Stripe PaymentIntent created.`, {
      ctCartId: ctCart.id,
      stripePaymentIntentId: paymentIntent.id,
      // Tax calculation integration
      ...(hasTaxCalculations && {
        hasTaxCalculations,
        taxCalculationCount,
      }),
    });

    const ctPayment = await this.ctPaymentService.createPayment({
      amountPlanned,
      ...(getCheckoutTransactionItemIdFromContext() && {
        checkoutTransactionItemId: getCheckoutTransactionItemIdFromContext(),
      }),
      ...({
        paymentMethodInfo: {
          paymentInterface: config.paymentInterface,
          /*name: { // Currently unused fields
            en: 'Stripe Payment Connector',
          },*/
        },
      } as any),
      /*paymentStatus: { // Currently unused fields
        interfaceCode: paymentIntent.id, //This is translated to PSP Status Code on the Order->Payment page
        interfaceText: paymentIntent.description || '', //This is translated to Description on the Order->Payment page
      },*/
      ...this.resolveInitialPaymentCustomerFields(ctCart),
      transactions: [
        {
          type: PaymentTransactions.AUTHORIZATION,
          amount: amountPlanned,
          state: this.convertPaymentResultCode(PaymentOutcome.INITIAL as PaymentOutcome),
          interactionId: paymentIntent.id,
        },
      ],
    });

    await this.ctCartService.addPayment({
      resource: {
        id: ctCart.id,
        version: ctCart.version,
      },
      paymentId: ctPayment.id,
    });

    log.info(`commercetools Payment and initial transaction created.`, {
      ctCartId: ctCart.id,
      ctPayment: ctPayment.id,
      stripePaymentIntentId: paymentIntent.id,
      merchantReturnUrl: merchantReturnUrl,
    });

    await this.updatePaymentIntentMetadata(paymentIntent.id, ctPayment.id);

    log.info(`Stripe update Payment id metadata.`);

    return {
      sClientSecret: paymentIntent.client_secret ?? '',
      paymentReference: ctPayment.id,
      merchantReturnUrl: merchantReturnUrl,
      cartId: ctCart.id,
      ...this.resolveBillingAddressFields(behaviorRule, ctCart),
    };
  }

  /**
   * pi_first: suppress setup_future_usage from the PaymentIntent. The PI is created without it
   * so that Stripe accepts the Blik payment method binding. If the merchant also needs saved-card
   * support, they should use the deferred flow.
   */
  private applyPiFirstOverride(
    flowType: 'deferred' | 'pi_first',
    setupFutureUsage: Stripe.PaymentIntentCreateParams.SetupFutureUsage | undefined,
  ): Stripe.PaymentIntentCreateParams.SetupFutureUsage | undefined {
    return flowType === 'pi_first' ? undefined : setupFutureUsage;
  }

  /**
   * expressWithCustomer: true only when the enabler used _Setup (session at render time) AND resolved
   * a Stripe customer — meaning Elements was created with setupFutureUsage and customerOptions.
   * expressCustomerSession signals this from the enabler via x-express-customer-session header.
   * _SetupExpress (deferred) never sets this header, so setup_future_usage stays off for that path.
   */
  private resolveExpressWithCustomer(
    expressCheckout: boolean,
    stripeCustomerId: string | undefined,
    expressCustomerSession: boolean,
  ): boolean {
    return expressCheckout && Boolean(stripeCustomerId) && expressCustomerSession;
  }

  private resolveInitialPaymentCustomerFields(ctCart: Cart): Pick<PaymentDraft, 'customer' | 'anonymousId'> {
    if (ctCart.customerId) {
      return { customer: { typeId: 'customer', id: ctCart.customerId } };
    }
    if (ctCart.anonymousId) {
      return { anonymousId: ctCart.anonymousId };
    }
    return {};
  }

  private async updatePaymentIntentMetadata(paymentIntentId: string, ctPaymentId: string): Promise<void> {
    try {
      const idempotencyKey = crypto.randomUUID();
      await stripeApi().paymentIntents.update(
        paymentIntentId,
        {
          metadata: {
            ct_payment_id: ctPaymentId,
          },
        },
        { idempotencyKey },
      );
    } catch (e) {
      throw wrapStripeError(e);
    }
  }

  private resolveBillingAddressFields(
    behaviorRule: PaymentBehaviorRule | undefined,
    ctCart: Cart,
  ): { billingAddress: string | undefined } | Record<string, never> {
    const collectBillingAddress = behaviorRule?.collectBillingAddress ?? getConfig().stripeCollectBillingAddress;
    return collectBillingAddress !== 'auto' ? { billingAddress: this.getBillingAddress(ctCart) } : {};
  }

  /**
   * Builds the params object for Stripe PaymentIntent creation.
   * Centralizes conditional fields (customer, setup_future_usage, shipping, tax hooks, multicapture) so that
   * createPaymentIntentStripe keeps a lower cognitive complexity.
   *
   * @param params - Cart, amount, config-derived values and optional customer/shipping/tax data.
   * @returns Stripe.PaymentIntentCreateParams to pass as first argument to paymentIntents.create().
   */
  private buildPaymentIntentCreateParams(params: {
    ctCart: Cart;
    amountPlanned: { centAmount: number; currencyCode: string };
    expressCheckout: boolean;
    expressWithCustomer: boolean;
    shippingAddress: Stripe.PaymentIntentCreateParams.Shipping | null | undefined;
    stripeCustomerId: string | undefined;
    setupFutureUsage: Stripe.PaymentIntentCreateParams.SetupFutureUsage | undefined;
    captureMethod: CaptureMethod;
    projectKey: string;
    stripeEnableMultiOperations: boolean;
    hasSingleTaxCalculation: boolean;
    taxCalculationReference: string | undefined;
    euBankTransferCountry: EuBankTransferCountry | undefined;
  }): Stripe.PaymentIntentCreateParams {
    const {
      ctCart,
      amountPlanned,
      expressCheckout,
      expressWithCustomer,
      shippingAddress,
      stripeCustomerId,
      setupFutureUsage,
      captureMethod,
      projectKey,
      stripeEnableMultiOperations,
      hasSingleTaxCalculation,
      taxCalculationReference,
      euBankTransferCountry,
    } = params;

    // undefined for every non-EUR cart and for every market with no configured IBAN country, which
    // means "send nothing and let Stripe resolve the variant from the currency".
    const bankTransferOptions = getBankTransferOptions({
      currencyCode: amountPlanned.currencyCode,
      euBankTransferCountry,
    });

    return {
      // Standard and express-with-known-customer paths both bind customer and setup_future_usage.
      // Express-without-customer (deferred session path) is one-shot: no customer binding.
      ...((!expressCheckout || expressWithCustomer) &&
        stripeCustomerId && {
          customer: stripeCustomerId,
          ...(setupFutureUsage && { setup_future_usage: setupFutureUsage }),
        }),
      amount: amountPlanned.centAmount,
      currency: amountPlanned.currencyCode,
      automatic_payment_methods: {
        enabled: true,
      },
      capture_method: captureMethod,
      metadata: {
        cart_id: ctCart.id,
        ct_project_key: projectKey,
        ...(ctCart.customerId ? { ct_customer_id: ctCart.customerId } : null),
      },
      ...(!expressCheckout && shippingAddress != null && { shipping: shippingAddress }),
      payment_method_options: {
        card: {
          ...(stripeEnableMultiOperations && {
            request_multicapture: 'if_available',
          }),
        },
        // A SIBLING KEY of `card`, not a layer over it — written after it, but never into it. A single
        // conditional spread of a whole merchant-controlled object, never a deep merge. Because
        // the key is written or absent as a unit, there is no path by which a nested
        // eu_bank_transfer.country could survive underneath our own bank_transfer.type — the
        // destination-of-funds choice this trusted-resolution path exists to keep away from the
        // browser. That protection comes from the SHAPE of the write, not from vigilance.
        //
        // There is nothing to merge with today: checkout accepts no caller-supplied
        // payment_method_options. GET /payments declares no body schema (routes/stripe-payment.route.ts)
        // and PaymentRequestSchema has no such field (dtos/stripe-payment.dto.ts). Composable, which
        // DOES accept them, needs a private applyBankTransferOverride to take this key back from the
        // client — see its stripe-payment.service.ts :872-922. That function is deliberately not
        // ported here, because a guard that cannot fire reads as a trust boundary that is not there.
        //
        // >>> IF CHECKOUT EVER ACCEPTS CALLER-SUPPLIED payment_method_options, PORT
        // >>> applyBankTransferOverride BEFORE DOING SO. A plain spread stops being sufficient the
        // >>> moment the incoming object is not entirely ours.
        //
        // Measured 2026-08-07: a EUR cart with a customer is ALREADY offered customer_balance with no
        // options sent at all, so this does not enable the rail — it only pins which IBAN the shopper
        // sees, instead of Stripe's currency-derived IE default. On a cart with no customer Stripe
        // accepts the create and silently discards these options, so guest carts need no guard.
        //
        // SETTING THESE OPTIONS IS NOT SUFFICIENT FOR THE RAIL TO APPEAR, and the interaction is
        // silent. Measured 2026-08-07 on the same account: adding a top-level setup_future_usage
        // ('off_session') drops customer_balance out of payment_method_types ENTIRELY and nulls these
        // options — Stripe filters methods that cannot be saved. So a merchant running with
        // STRIPE_PAYMENT_INTENT_SETUP_FUTURE_USAGE=off_session gets no bank-transfer tab on exactly
        // the carts that qualify for it (a customer is bound), with no error anywhere. capture_method
        // 'manual' has the same effect. Neither is a bug to fix here — it is Stripe's own filtering,
        // and silently rewriting a merchant's mandate or capture policy to force a rail back on would
        // be the more surprising behaviour. A merchant who wants bank transfer in one market says so
        // with the fields that already exist: {"DE":{"setupFutureUsage":"none"}}. Tracked as
        // 2026-08-07-014.
        ...(bankTransferOptions && { customer_balance: bankTransferOptions }),
      },
      ...(hasSingleTaxCalculation && {
        hooks: {
          inputs: {
            tax: {
              calculation: taxCalculationReference!,
            },
          },
        },
      }),
    };
  }

  /**
   * Update the PaymentIntent in Stripe to mark the Authorization in commercetools as successful.
   * Validates the PaymentIntent with Stripe (retrieve), status, metadata.ct_payment_id, and amount/currency
   * before updating the payment in CT. On any validation failure, logs a warning and throws (no update).
   *
   * @param {string} paymentIntentId - The Intent id created in Stripe.
   * @param {string} paymentReference - The identifier of the payment associated with the PaymentIntent in Stripe.
   * @return {Promise<PaymentModificationStatus>} APPROVED when succeeded/requires_capture,
   * PENDING for async settlement — `processing` (crypto/stablecoin) or `requires_action` carrying
   * bank transfer instructions. PENDING makes the route answer 202, never a success.
   * @throws Error when validation fails (status, metadata, or amount/currency mismatch).
   */
  public async updatePaymentIntentStripeSuccessful(
    paymentIntentId: string,
    paymentReference: string,
  ): Promise<PaymentModificationStatus> {
    const ctCart = await this.ctCartService.getCart({
      id: getCartIdFromContext(),
    });

    const ctPayment = await this.ctPaymentService.getPayment({
      id: paymentReference,
    });
    const amountPlanned = ctPayment.amountPlanned;

    // (1) Retrieve the PaymentIntent from Stripe (source of truth)
    let stripePaymentIntent: Stripe.PaymentIntent;
    try {
      stripePaymentIntent = await stripeApi().paymentIntents.retrieve(paymentIntentId);
    } catch (e) {
      log.warn('updatePaymentIntentStripeSuccessful: failed to retrieve PaymentIntent from Stripe', {
        paymentIntentId,
        paymentReference,
        error: e,
      });
      throw new Error(`Invalid PaymentIntent: could not retrieve from Stripe`);
    }

    // (2) Check status — succeeded/requires_capture (synchronous), processing (async settlement),
    // or requires_action for a bank transfer that is awaiting funds.
    //
    // `requires_action` is NOT in the flat allowlist, and that is the whole point. Card 3DS
    // (`use_stripe_sdk`), Boleto and every redirect-based method reach this gate with the same
    // status, and for them the confirmation genuinely has NOT happened — accepting the status
    // wholesale would write an authorization for a payment the buyer never completed. Only a
    // PaymentIntent carrying `next_action.display_bank_transfer_instructions` is admitted, using the
    // same predicate the webhook route uses so the two cannot drift.
    const isBankTransferAwaitingFunds =
      stripePaymentIntent.status === 'requires_action' && isBankTransferNextAction(stripePaymentIntent);
    const allowedStatuses = ['succeeded', 'requires_capture', 'processing'];
    if (!allowedStatuses.includes(stripePaymentIntent.status) && !isBankTransferAwaitingFunds) {
      log.warn('updatePaymentIntentStripeSuccessful: PaymentIntent status not allowed', {
        paymentIntentId,
        paymentReference,
        status: stripePaymentIntent.status,
        allowedStatuses,
        nextActionType: stripePaymentIntent.next_action?.type ?? null,
      });
      throw new Error(`Invalid PaymentIntent: status "${stripePaymentIntent.status}" is not allowed`);
    }

    // (3) Validate metadata — require metadata.ct_payment_id === paymentReference
    const metadataCtPaymentId = stripePaymentIntent.metadata?.ct_payment_id;
    if (metadataCtPaymentId !== paymentReference) {
      log.warn('updatePaymentIntentStripeSuccessful: metadata.ct_payment_id does not match paymentReference', {
        paymentIntentId,
        paymentReference,
        metadataCtPaymentId: metadataCtPaymentId ?? null,
      });
      throw new Error(`Invalid PaymentIntent: metadata.ct_payment_id does not match this payment`);
    }

    // (4) Validate amount/currency — must match ctPayment.amountPlanned
    const stripeAmount = stripePaymentIntent.amount;
    const stripeCurrency = (stripePaymentIntent.currency ?? '').toLowerCase();
    const expectedCentAmount = amountPlanned.centAmount;
    const expectedCurrency = (amountPlanned.currencyCode ?? '').toLowerCase();
    if (stripeAmount !== expectedCentAmount || stripeCurrency !== expectedCurrency) {
      log.warn('updatePaymentIntentStripeSuccessful: amount or currency mismatch', {
        paymentIntentId,
        paymentReference,
        stripeAmount,
        stripeCurrency,
        expectedCentAmount,
        expectedCurrency,
      });
      throw new Error(
        `Invalid PaymentIntent: amount/currency mismatch (Stripe: ${stripeAmount} ${stripeCurrency}, expected: ${expectedCentAmount} ${expectedCurrency})`,
      );
    }

    log.info(`PaymentIntent confirmed.`, {
      ctCartId: ctCart.id,
      stripePaymentIntentId: ctPayment.interfaceId,
      amountPlanned: JSON.stringify(amountPlanned),
    });

    // Async settlement — crypto/stablecoin via `processing`, bank transfer via `requires_action`.
    // Write a Pending authorization ONLY — never Charge/Success. The order is created later by the
    // webhook on payment_intent.succeeded. Dedup against a Pending/Success the webhook may already
    // have written. Return PENDING so the route responds 202 (not a success), which is what lets the
    // enabler surface a non-success outcome instead of an error.
    //
    // WITHOUT THIS BRANCH, BANK TRANSFER ENDS ON A FAILURE SCREEN. Measured 2026-08-13 against the
    // commercetools overlay: the buyer sees Stripe's own instructions modal, closes it to go to their
    // bank — which is what they always do — and the enabler's throw surfaces as `payment_failed`.
    // Nobody wires money after being told the payment failed.
    //
    // THE AMOUNT COMES FROM `amountPlanned`, NOT from the PaymentIntent, and unlike the webhook path
    // that is safe here rather than lucky: validation (4) above already proved
    // `stripePaymentIntent.amount === amountPlanned.centAmount`, so the two cannot disagree at this
    // point. Do not "align" this with the converter's `pi.amount` — there is no bug to fix.
    if (stripePaymentIntent.status === 'processing' || isBankTransferAwaitingFunds) {
      await this.writeAsyncSettlementPendingAuthorization(ctPayment, paymentIntentId);
      return PaymentModificationStatus.PENDING;
    }

    await this.ctPaymentService.updatePayment({
      id: ctPayment.id,
      pspReference: paymentIntentId,
      transaction: {
        interactionId: paymentIntentId,
        type: PaymentTransactions.AUTHORIZATION,
        amount: amountPlanned,
        state: this.convertPaymentResultCode(PaymentOutcome.AUTHORIZED as PaymentOutcome),
      },
    });

    return PaymentModificationStatus.APPROVED;
  }

  /**
   * Writes the Pending authorization for an async-settlement confirmation, deduped.
   *
   * Extracted from `updatePaymentIntentStripeSuccessful` so that method stays under the cognitive
   * complexity ceiling `connect validate` enforces — adding the bank transfer condition pushed it
   * from 15 to 16 and failed the gate. Behaviour is unchanged.
   *
   * The dedup exists because the webhook may have written the same Pending already: for bank
   * transfer both this gate and `payment_intent.requires_action` produce it, and Stripe does not
   * guarantee which arrives first.
   *
   * The amount is `ctPayment.amountPlanned`, and that is safe rather than lucky — the caller has
   * already validated that the PaymentIntent's `amount` equals it, so the two cannot disagree here.
   * Do not switch this to the PaymentIntent's own amount to "match" the converter.
   */
  private async writeAsyncSettlementPendingAuthorization(ctPayment: Payment, paymentIntentId: string): Promise<void> {
    const hasAuthPending = this.ctPaymentService.hasTransactionInState({
      payment: ctPayment,
      transactionType: 'Authorization',
      states: ['Pending'],
    });
    const hasChargeSuccess = this.ctPaymentService.hasTransactionInState({
      payment: ctPayment,
      transactionType: 'Charge',
      states: ['Success'],
    });
    if (hasAuthPending || hasChargeSuccess) {
      return;
    }

    await this.ctPaymentService.updatePayment({
      id: ctPayment.id,
      pspReference: paymentIntentId,
      transaction: {
        interactionId: paymentIntentId,
        type: PaymentTransactions.AUTHORIZATION,
        amount: ctPayment.amountPlanned,
        state: PaymentStatus.PENDING,
      },
    });
  }

  /**
   * Return the current cart amount and line items for Express Checkout (commercetools cart shape).
   * Used after shipping address/method changes; cart is already updated by Checkout via callbacks.
   * Requires session (x-session-id) so cartId comes from context.
   *
   * @returns {Promise<GetExpressPaymentDataResponseSchemaDTO>} totalPrice, currencyCode, and lineItems (each with amount object and type).
   */
  public async getExpressPaymentData(): Promise<GetExpressPaymentDataResponseSchemaDTO> {
    const ctCart = await this.ctCartService.getCart({ id: getCartIdFromContext() });
    const amountPlanned = await this.ctCartService.getPaymentAmount({ cart: ctCart });

    const currencyCode = amountPlanned.currencyCode;
    const fractionDigits = amountPlanned.fractionDigits;
    const totalPrice = {
      centAmount: amountPlanned.centAmount,
      currencyCode,
      fractionDigits,
    };

    type LineItem = {
      name: string;
      amount: { centAmount: number; currencyCode: string; fractionDigits: number };
      type: string;
    };
    const lineItems: LineItem[] = [];

    const cartWithShipping = ctCart as Cart & {
      shippingInfo?: { price?: { centAmount?: number }; shippingMethodName?: string };
      taxedPrice?: { totalNet?: { centAmount?: number }; totalTax?: { centAmount?: number } };
    };
    if (cartWithShipping.taxedPrice) {
      const totalNet = cartWithShipping.taxedPrice.totalNet?.centAmount ?? amountPlanned.centAmount;
      const totalTax = cartWithShipping.taxedPrice.totalTax?.centAmount ?? 0;
      lineItems.push({
        name: 'Subtotal',
        amount: { centAmount: totalNet, currencyCode, fractionDigits },
        type: 'SUBTOTAL',
      });
      if (totalTax > 0) {
        lineItems.push({
          name: 'Tax',
          amount: { centAmount: totalTax, currencyCode, fractionDigits },
          type: 'TAX',
        });
      }
    } else {
      const shippingCents = cartWithShipping.shippingInfo?.price?.centAmount ?? 0;
      const subtotalCents = amountPlanned.centAmount - shippingCents;
      lineItems.push({
        name: 'Subtotal',
        amount: { centAmount: subtotalCents, currencyCode, fractionDigits },
        type: 'SUBTOTAL',
      });
      if (shippingCents > 0) {
        const shippingName = cartWithShipping.shippingInfo?.shippingMethodName ?? 'Shipping';
        lineItems.push({
          name: shippingName,
          amount: { centAmount: shippingCents, currencyCode, fractionDigits },
          type: 'SHIPPING',
        });
      }
    }
    if (lineItems.length === 0) {
      lineItems.push({
        name: 'Total',
        amount: { centAmount: amountPlanned.centAmount, currencyCode, fractionDigits },
        type: 'TOTAL',
      });
    }

    return { totalPrice, currencyCode, lineItems };
  }

  /**
   * Return the Stripe payment configuration and the cart amount planed information.
   *
   * @param {string} opts - Options for initializing the cart payment.
   * @return {Promise<ConfigElementResponseSchemaDTO>} Returns a promise that resolves with the cart information, appearance, and capture method.
   */
  public async initializeCartPayment(opts: string): Promise<ConfigElementResponseSchemaDTO> {
    const {
      stripeCaptureMethod,
      stripePaymentElementAppearance,
      stripeLayout,
      stripeCollectBillingAddress,
      stripeBehaviorPaymentElement,
      stripePaymentFlow,
      stripePaymentBehaviorRules,
    } = getConfig();
    const ctCart = await this.ctCartService.getCart({ id: getCartIdFromContext() });

    // Resolve per-cart behavior rule.
    //
    // MUST USE THE SAME RESOLUTION AS createPaymentIntentStripe — this site tells the enabler how to
    // build the element, that site builds the PaymentIntent, and Stripe validates the deferred element
    // options against the retrieved intent at confirm. If the two drift apart the confirm is rejected
    // for every cart in that market. There is a test asserting both sites resolve identically for the
    // same cart; if it fails, one of the two has drifted — do not weaken it.
    const { rule: behaviorRule } = resolvePaymentBehaviorWithSteeringCheck(stripePaymentBehaviorRules, ctCart);
    const effectiveFlowType = behaviorRule?.flowType ?? stripePaymentFlow;
    const effectiveCaptureMethod = behaviorRule?.captureMethod ?? stripeCaptureMethod;
    const effectiveCollectBillingAddress = behaviorRule?.collectBillingAddress ?? stripeCollectBillingAddress;

    const amountPlanned = await this.ctCartService.getPaymentAmount({ cart: ctCart });
    const appearance = stripePaymentElementAppearance;
    // pi_first: PaymentIntent is created eagerly by the enabler before elements.create().
    // setup_future_usage is set on the PI directly in that path; do not include it in the
    // deferred elements config or Stripe will reject { clientSecret } + setupFutureUsage together.
    const setupFutureUsage =
      effectiveFlowType === 'pi_first'
        ? undefined
        : this.getPaymentIntentSetupFutureUsage(ctCart, behaviorRule?.setupFutureUsage);
    const paymentElementOptions = parsePaymentElementOptions(stripeBehaviorPaymentElement);

    log.info(`Cart and Stripe.Element ${opts} config retrieved.`, {
      cartId: ctCart.id,
      cartInfo: {
        amount: amountPlanned.centAmount,
        currency: amountPlanned.currencyCode,
      },
      stripeElementAppearance: appearance,
      stripeCaptureMethod: effectiveCaptureMethod,
      stripeSetupFutureUsage: setupFutureUsage,
      layout: stripeLayout,
      collectBillingAddress: effectiveCollectBillingAddress,
      paymentElementOptions,
      stripePaymentFlow: effectiveFlowType,
      ...(behaviorRule && { behaviorRuleApplied: true }),
    });

    return {
      cartInfo: {
        amount: amountPlanned.centAmount,
        currency: amountPlanned.currencyCode,
      },
      appearance: appearance,
      captureMethod: effectiveCaptureMethod,
      setupFutureUsage: setupFutureUsage,
      paymentElementOptions: JSON.stringify(paymentElementOptions),
      layout: stripeLayout,
      collectBillingAddress: effectiveCollectBillingAddress as CollectBillingAddressOptions,
      flowType: effectiveFlowType,
    };
  }

  /**
   * Return the Stripe payment configuration and the cart amount planed information.
   *
   * @return {Promise<ConfigElementResponseSchemaDTO>} Returns a promise that resolves with the cart information, appearance, and capture method.
   */
  public applePayConfig(): string {
    return getConfig().stripeApplePayWellKnown;
  }

  private convertPaymentResultCode(resultCode: PaymentOutcome): string {
    switch (resultCode) {
      case PaymentOutcome.AUTHORIZED:
        return 'Success';
      case PaymentOutcome.REJECTED:
        return 'Failure';
      default:
        return 'Initial';
    }
  }

  /**
   * Processes a Stripe event and updates the corresponding payment in commercetools.
   *
   * Handles standard payment events as well as multicapture scenarios for payment intents
   * with manual capture and multicapture enabled. In multicapture cases, updates the transaction
   * data with the correct balance transaction information from Stripe.
   *
   * @param {Stripe.Event} event - The Stripe event object to process.
   * @returns {Promise<void>} - Resolves when the payment has been updated.
   */
  /**
   * The payment method type for a `payment_intent.*` event, or `undefined` if it cannot be told.
   *
   * A PaymentIntent payload names its method only by id, so the type needs one Stripe read. This is
   * generic on purpose rather than special-cased to bank transfer: `next_action` would have
   * identified a bank transfer for free, but ONLY a bank transfer, and the field is empty for every
   * asynchronous rail — reading the PaymentMethod fixes all of them with the same call.
   *
   * NEVER THROWS, and that is load-bearing rather than defensive. This sits in a webhook handler that
   * must return non-2xx when a commercetools update fails so Stripe retries (KI-001); letting a
   * cosmetic lookup fail the handler would turn a missing label into a redelivery loop against an
   * update that already succeeded. An unresolved method is logged and left unset.
   *
   * `payment_method` arrives as an id in webhook payloads, but Stripe types it as a union with the
   * expanded object, and an expanded one is free to read — so both shapes are handled instead of
   * assuming the one seen in practice.
   */
  private async resolvePaymentMethodType(event: Stripe.Event): Promise<string | undefined> {
    if (!event.type.startsWith('payment')) return undefined;

    const paymentIntent = event.data.object as Stripe.PaymentIntent;
    const paymentMethod = paymentIntent.payment_method;
    if (!paymentMethod) return undefined;
    if (typeof paymentMethod !== 'string') return paymentMethod.type;

    try {
      const retrieved = await stripeApi().paymentMethods.retrieve(paymentMethod);
      return retrieved.type;
    } catch (lookupError) {
      // Scalars only — a Stripe error carries `raw`, `headers` and the full `payment_intent` as own
      // enumerable properties, and winston would serialize all of them.
      const err = lookupError as Error & { statusCode?: number; code?: string };
      log.warn('Could not resolve the payment method type — leaving it unset', {
        eventType: event.type,
        errorType: err.name,
        errorMessage: err.message,
        errorCode: err.code,
        errorStatus: err.statusCode,
      });
      return undefined;
    }
  }

  public async processStripeEvent(event: Stripe.Event): Promise<void> {
    log.info('Processing notification', { event: JSON.stringify(event.id) });
    try {
      const updateData = this.stripeEventConverter.convert(event, await this.resolvePaymentMethodType(event));

      // Fail fast when the PaymentIntent carries no ct_payment_id: it was not created by this
      // connector — a Dashboard-created intent, or another integration sharing the same Stripe
      // account — so there is nothing here to update.
      //
      // Note the shape this actually takes. Stripe always returns `metadata: {}` on a
      // PaymentIntent, so `getCtPaymentId` does not throw; it returns undefined and `convert()`
      // succeeds. The failure surfaces one line down instead, where `getPayment({ id: undefined })`
      // throws — and for the events in ASYNC_PENDING_EVENTS that throw is re-thrown below,
      // producing a 500 that Stripe retries for three days. Sustained 5xx can get the whole
      // webhook endpoint disabled, which takes down every event and not just this one.
      //
      // THIS RETURNS 200, AND THAT IS NOT THE KI-001 VIOLATION IT RESEMBLES. KI-001 forbids
      // answering 200 after a commercetools write FAILED, because a retry would fix it. Here no
      // write was attempted and no retry can ever help: the metadata will never appear on an
      // intent this connector did not create. Answering 5xx would buy three days of pointless
      // retries and risk the endpoint. Deliberately a warn rather than an error — this is a
      // foreign event, not a fault of ours.
      //
      // Scoped to processStripeEvent on purpose. processStripeEventRefunded and
      // processStripeEventMultipleCaptured also convert, but both swallow their errors, so the
      // same payload costs them a logged error rather than a retry storm.
      if (!updateData.id) {
        log.warn('Skipping event: the PaymentIntent carries no commercetools payment id in its metadata', {
          eventType: event.type,
          pspReference: updateData.pspReference,
        });
        return;
      }

      // Ordering + dedup guard for async settlement (crypto: payment_intent.processing;
      // bank transfer: payment_intent.requires_action). Stripe does not guarantee event order and
      // may redeliver, and the synchronous gate (confirmPayments) may have already written a
      // Pending authorization. Skip writing a duplicate Pending if the payment is already
      // resolved (Charge/Success) or a Pending authorization already exists. Scoped to the async
      // pending events — every other event type is unaffected.
      if (
        (ASYNC_PENDING_EVENTS as readonly string[]).includes(event.type) &&
        (await this.isRedundantAsyncPendingEvent(event.type, updateData))
      ) {
        return;
      }

      if (
        updateData.transactions.length === 0 &&
        (ZERO_TRANSACTION_PERSIST_EVENTS as readonly string[]).includes(event.type)
      ) {
        // The converter wrote no transaction on purpose, but the event still has to leave an
        // audit trail: this persists the interface interaction alone. Note what is NOT done here
        // — no authorization is promoted and no amount is booked. For partially_funded the funds
        // sit in the customer's cash balance, not on the platform balance, so any promotion would
        // book revenue that does not exist.
        const updatedPayment = await this.ctPaymentService.updatePayment({
          ...updateData,
        });

        log.info('Payment information updated', {
          paymentId: updatedPayment.id,
          version: updatedPayment.version,
          pspReference: updateData.pspReference,
          paymentMethod: updateData.paymentMethod,
        });
      } else {
        //does payment intent event have multicapture?
        await this.applyMulticaptureAdjustment(event, updateData);

        for (const tx of updateData.transactions) {
          const updatedPayment = await this.ctPaymentService.updatePayment({
            ...updateData,
            transaction: tx,
          });

          log.info('Payment updated after processing the notification', {
            paymentId: updatedPayment.id,
            version: updatedPayment.version,
            pspReference: updateData.pspReference,
            paymentMethod: updateData.paymentMethod,
            transaction: JSON.stringify(tx),
          });
        }
      }
      if (event.type === StripeEvent.PAYMENT_INTENT__SUCCEEDED) {
        await this.transitionPendingAuthorizationToSuccess(updateData);
      }
    } catch (e) {
      // Never hand the error object itself to the logger. Stripe errors expose `raw`,
      // `payment_intent`, `charge`, `payment_method` and `headers` as own enumerable
      // properties, and StripeApiError additionally carries the original error as `cause`
      // (errors/stripe-api.error.ts:22) — winston serializes own enumerables, so a failure on a
      // customer_balance PaymentIntent would log the full PI, `client_secret` and
      // `next_action.display_bank_transfer_instructions.financial_addresses` included. That is
      // the exact payload StripeEventConverter.buildPspInteractionResponse exists to keep out of
      // commercetools; logging it here would defeat that through a different channel.
      //
      // Only scalars are extracted. `eventId`/`eventType` are NEW: this site previously logged
      // no event identity at all, and `message` is non-enumerable on Error (and stays so when
      // StripeError reassigns it), so `{ error: e }` was not logging the message either.
      const err = e as Error & { type?: string; code?: string; statusCode?: number; httpErrorStatus?: number };
      log.error('Error processing notification', {
        eventId: event.id,
        eventType: event.type,
        errorType: err.type ?? err.name,
        errorMessage: err.message,
        errorCode: err.code,
        errorStatus: err.statusCode ?? err.httpErrorStatus,
      });
      // For async settlement, do NOT swallow write failures: re-throw so the webhook responds
      // non-2xx and Stripe retries (the dedup guard above prevents a duplicate Pending on
      // redelivery, and a swallowed ConcurrentModification/409 would otherwise leave the payment
      // stuck without the Pending authorization). payment_intent.partially_funded is deliberately
      // excluded — it writes no transaction, so losing it costs an audit line rather than
      // correctness. Other event types keep the existing behavior (log and return) so the card
      // regression is untouched.
      if ((ASYNC_PENDING_EVENTS as readonly string[]).includes(event.type)) {
        throw e;
      }
      return;
    }
  }

  /**
   * Ordering + dedup guard for async settlement: crypto via `payment_intent.processing`, bank
   * transfer via `payment_intent.requires_action` — the members of ASYNC_PENDING_EVENTS. Returns
   * true when a duplicate Pending authorization would result, i.e. the payment is already
   * resolved (Charge/Success) or a Pending authorization already exists.
   *
   * `eventType` is used only for the log line. The CALLER decides which events reach here; this
   * method deliberately does not check the type itself, so widening the set is a one-line change
   * to ASYNC_PENDING_EVENTS rather than an edit in two places that can disagree.
   */
  private async isRedundantAsyncPendingEvent(
    eventType: string,
    updateData: StripeEventUpdatePayment,
  ): Promise<boolean> {
    const payment = await this.ctPaymentService.getPayment({ id: updateData.id });
    const hasChargeSuccess = this.ctPaymentService.hasTransactionInState({
      payment,
      transactionType: 'Charge',
      states: ['Success'],
    });
    const hasAuthPending = this.ctPaymentService.hasTransactionInState({
      payment,
      transactionType: 'Authorization',
      states: ['Pending'],
    });
    if (hasChargeSuccess || hasAuthPending) {
      log.info(`Skipping ${eventType} — payment already resolved or pending transaction exists`, {
        paymentId: updateData.id,
        pspReference: updateData.pspReference,
      });
      return true;
    }
    return false;
  }

  /**
   * Detects multicapture on a manual-capture PaymentIntent event and, when more than one balance
   * transaction exists on the latest charge, overwrites updateData's transactions with the
   * correct balance transaction amount/reference.
   */
  private async applyMulticaptureAdjustment(event: Stripe.Event, updateData: StripeEventUpdatePayment): Promise<void> {
    if (!event.type.startsWith('payment')) {
      return;
    }
    const pi = event.data.object as Stripe.PaymentIntent;
    if (
      pi.capture_method === 'manual' &&
      pi.payment_method_options?.card?.request_multicapture === 'if_available' &&
      typeof pi.latest_charge === 'string'
    ) {
      const balanceTransactions = await stripeApi().balanceTransactions.list({
        source: pi.latest_charge,
        limit: 10,
      });

      if (balanceTransactions.data.length > 1) {
        //it is multicapture, so we need to update the transactions
        updateData.transactions.forEach((tx) => {
          tx.interactionId = balanceTransactions.data[0].id;
          tx.amount = {
            centAmount: balanceTransactions.data[0].amount,
            currencyCode: balanceTransactions.data[0].currency.toUpperCase(),
          };
        });
      }
    }
  }

  /**
   * Best-effort: transitions a lingering Pending authorization (written during
   * payment_intent.processing for async crypto settlement) to Success, so it does not stay stuck
   * in Pending after the payment completes. No-op for card payments that never went through
   * processing. Isolated try/catch so a failure here never blocks the successful-payment flow.
   */
  private async transitionPendingAuthorizationToSuccess(updateData: StripeEventUpdatePayment): Promise<void> {
    try {
      const payment = await this.ctPaymentService.getPayment({ id: updateData.id });
      const hasAuthPending = this.ctPaymentService.hasTransactionInState({
        payment,
        transactionType: 'Authorization',
        states: ['Pending'],
      });
      if (hasAuthPending) {
        await this.ctPaymentService.updatePayment({
          id: payment.id,
          pspReference: updateData.pspReference,
          transaction: {
            type: PaymentTransactions.AUTHORIZATION,
            state: this.convertPaymentResultCode(PaymentOutcome.AUTHORIZED as PaymentOutcome),
            amount: updateData.transactions[0]?.amount ?? payment.amountPlanned,
            interactionId: updateData.pspReference,
          },
        });
        log.info('Transitioned pending authorization to Success after payment_intent.succeeded', {
          paymentId: payment.id,
          pspReference: updateData.pspReference,
        });
      }
    } catch (authTransitionError) {
      log.warn('Could not transition pending authorization to Success (non-blocking)', {
        error: authTransitionError,
        paymentId: updateData.id,
      });
    }
  }

  /**
   * Reflects the Stripe payment outcome onto the commercetools `Order.paymentState`.
   *
   * WHY THIS EXISTS. commercetools never derives `Order.paymentState` from the linked Payment's
   * transactions — it only ever changes through the `changePaymentState` update action. And in the
   * checkout model commercetools Checkout creates the order itself, without a state: measured
   * 2026-08-18 on the bank-transfer rail, the order is created in the same second as
   * `payment_intent.requires_action` (02:41:19.883), two minutes BEFORE the money exists, and is
   * never touched again — `paymentState` stayed `null` even after the Payment carried
   * `Authorization/Success` + `Charge/Success`. Nobody had noticed because a stale sibling
   * deployment running pre-`0ab8d2c` legacy code was receiving the same webhooks by fan-out on the
   * shared Stripe account and stamping `Paid` at order creation. Turning its webhook off is what
   * exposed the gap (verified in the 2026-08-18 session), and it was also the source of the
   * `409 ConcurrentModification` conflicts.
   *
   * WHY IT UPDATES AND NEVER CREATES. `CommercetoolsOrderService` in connect-payments-sdk 0.27.2
   * exposes exactly one method — `getOrderByPaymentId()` — and no write. This connector DID create
   * orders once (`createOrderFromCart(cart, PAID)`) and that code was removed in `0ab8d2c`
   * precisely because it raced commercetools Checkout and produced 409s. So "do it like the
   * composable connector, create the order once the money lands" is not portable here: composable
   * owns the cart, this connector does not. Reflecting onto the order commercetools already created
   * is the only shape available. Do not reintroduce order creation.
   *
   * WHY THE WRITE USES RAW `ctAPI`. Same reason — the typed service is read-only. This mirrors the
   * pattern already used for customers (`getCtCustomer`, `updateCustomerById`) and needs the
   * `manage_orders` scope, which is already in the health-check `requiredPermissions` (:111),
   * `connect.yaml` and `context/deployment.md`.
   *
   * BEST-EFFORT IS A CONTRACT, NOT A CAVEAT. This method never throws. `processStripeEvent()`
   * rethrows for `ASYNC_PENDING_EVENTS` so Stripe retries a failed CT write (KI-001); if this
   * method could propagate, an order-state failure would trigger that retry machinery for a write
   * that is not part of the payment record. The Payment object remains the source of truth for
   * transaction state (ADR-003); the order's `paymentState` is a projection of it.
   *
   * @param event A `payment_intent.*` event. Types absent from ORDER_PAYMENT_STATE_BY_EVENT no-op.
   */
  public async reflectOrderPaymentStateBestEffort(event: Stripe.Event): Promise<void> {
    const targetState = ORDER_PAYMENT_STATE_BY_EVENT[event.type as StripeEvent];
    if (!targetState) {
      return;
    }

    try {
      // Every event in the map is `payment_intent.*`, so the payload is always a PaymentIntent and
      // the stamp is read directly rather than through StripeEventConverter.convert(). Going
      // through the converter would be wrong twice over: it throws for the cash-balance event, and
      // it does the whole pspInteraction redaction pass, which this path has no use for.
      const paymentIntent = event.data.object as Stripe.PaymentIntent;
      const ctPaymentId = paymentIntent.metadata?.ct_payment_id;

      // Same reasoning as the guard in processStripeEvent: a PaymentIntent created outside this
      // connector (Dashboard, or another integration on the same Stripe account) carries no stamp,
      // and there is no order of ours to reflect onto. Stripe always returns `metadata: {}`, so
      // this is an absent key rather than a throw.
      if (!ctPaymentId) {
        log.warn('Skipping order paymentState: the PaymentIntent carries no commercetools payment id', {
          eventType: event.type,
          pspReference: paymentIntent.id,
        });
        return;
      }

      const order = await this.resolveOrderForPaymentStateReflection(ctPaymentId, targetState, event.type);
      if (!order) {
        return;
      }

      if (!shouldTransitionOrderPaymentState(order.paymentState, targetState)) {
        log.info('Order paymentState left unchanged', {
          orderId: order.id,
          currentPaymentState: order.paymentState ?? 'unset',
          targetPaymentState: targetState,
          eventType: event.type,
        });
        return;
      }

      if (
        targetState !== OrderPaymentState.PENDING &&
        !(await this.connectorOwnsOrderPaymentState(order, ctPaymentId))
      ) {
        // The synchronous split decided in the 2026-08-18 session: for a card that settles inline,
        // finalizing the order is the merchant's/site's job, and commercetools says so explicitly
        // ("it's your responsibility to decide how to proceed with the created Order"). The
        // connector registers the payment; it does not decide order state for a rail it never had
        // to hold open. Leaving the order unset is the CORRECT outcome here, not a missed write.
        log.info('Order paymentState not owned by the connector — leaving it to the merchant process', {
          orderId: order.id,
          targetPaymentState: targetState,
          eventType: event.type,
        });
        return;
      }

      await this.writeOrderPaymentState(order, ctPaymentId, targetState, event.type);
    } catch (orderStateError) {
      // Scalars only — never the error object. A CT/Stripe error carries `body`, `raw`,
      // `payment_intent` and `headers` as own enumerable properties, and winston serializes those,
      // which would put the full PaymentIntent (client_secret and
      // next_action.display_bank_transfer_instructions.financial_addresses included) into the log
      // and defeat the redaction choke point in StripeEventConverter through another channel.
      const err = orderStateError as Error & { statusCode?: number; code?: string };
      log.warn('Could not reflect the payment outcome onto the order paymentState (non-blocking)', {
        eventType: event.type,
        errorType: err.name,
        errorMessage: err.message,
        errorCode: err.code,
        errorStatus: err.statusCode,
      });
    }
  }

  /**
   * Resolves the order for a payment, tolerating the order not existing yet.
   *
   * `getOrderByPaymentId()` THROWS when its predicate matches anything other than exactly one
   * order — including zero — so "not created yet" and "commercetools is unavailable" arrive as the
   * same kind of failure. That is why the retry is unconditional rather than keyed on the error
   * type: both causes benefit from waiting, and discriminating on an SDK-internal error class
   * would couple this to a shape that can change.
   *
   * THE RETRY EXISTS FOR A MEASURED RACE, not as defensive padding. On the bank-transfer rail the
   * order is created ~883 ms AFTER `payment_intent.requires_action` fires, so the first lookup
   * genuinely loses roughly half the time. Without the retry the `Pending` write is a coin flip,
   * and losing it is not self-correcting: if the shopper then abandons the transfer, no further
   * event ever arrives and the order stays unset forever — indistinguishable from a card order
   * that never got a webhook, which is the exact ambiguity this whole change removes.
   *
   * Only `Pending` targets wait. A terminal target arrives minutes to days later, by which time the
   * order either exists or the payment was never completed through checkout at all; waiting would
   * add latency to every settlement webhook to fix nothing.
   */
  private async resolveOrderForPaymentStateReflection(
    ctPaymentId: string,
    targetState: OrderPaymentState,
    eventType: string,
  ): Promise<Order | undefined> {
    const attempts = targetState === OrderPaymentState.PENDING ? ORDER_LOOKUP_RETRY_DELAYS_MS.length + 1 : 1;

    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        return await this.ctOrderService.getOrderByPaymentId({ paymentId: ctPaymentId });
      } catch (lookupError) {
        const isLastAttempt = attempt === attempts - 1;
        if (isLastAttempt) {
          const err = lookupError as Error;
          // WARN, not info, when a Pending target exhausts its retries — and the level is the point.
          // This is the one outcome that degrades silently: the money is genuinely in flight, and if
          // the shopper then abandons the transfer no further event ever arrives, so the order stays
          // unset forever. Logged at info it looks like routine flow control; it is the signal that
          // ORDER_LOOKUP_RETRY_DELAYS_MS needs widening, and the only place that signal exists. A
          // terminal target reaching here is genuinely unremarkable (the order may never have been
          // created), so it stays at info.
          const exhaustedPendingWrite = targetState === OrderPaymentState.PENDING && attempts > 1;
          const logAtLevel = exhaustedPendingWrite ? log.warn : log.info;
          logAtLevel('No commercetools order resolved for this payment — skipping the order paymentState write', {
            eventType,
            attempts,
            targetPaymentState: targetState,
            retryScheduleMs: ORDER_LOOKUP_RETRY_DELAYS_MS.join(','),
            errorType: err.name,
            errorMessage: err.message,
          });
          return undefined;
        }
        await this.delay(ORDER_LOOKUP_RETRY_DELAYS_MS[attempt]);
      }
    }

    /* istanbul ignore next: unreachable — the loop always returns on its last iteration, but
       TypeScript cannot prove `attempts >= 1` so the return is required to satisfy the signature */
    return undefined;
  }

  /**
   * Does the connector own this order's `paymentState`?
   *
   * Ownership is what keeps the synchronous card flow untouched. Two independent signals, either
   * sufficient:
   *
   * 1. **The order is already `Pending`.** Only this connector writes that, so it is our mark.
   * 2. **The Payment carries an `Authorization/Pending`.** Written only by async rails — the
   *    converter's `processing`/`requires_action` cases and the confirm gate's `PENDING` outcome.
   *    A synchronous card payment never has one.
   *
   * Signal 2 is not redundant: it is what recovers the case where the `Pending` order write lost
   * the creation race above. Without it, a bank transfer whose `Pending` write was skipped would
   * ALSO be skipped at settlement, and the order would stay unset despite the money arriving —
   * turning a cosmetic miss into a permanent one.
   *
   * Read BEFORE `transitionPendingAuthorizationToSuccess()` flips that transaction to `Success`,
   * which is why the route calls this method ahead of `processStripeEvent()`. Reordering those two
   * calls silently destroys signal 2 for every `payment_intent.succeeded`, with no test failing
   * unless it asserts the order of the two route calls.
   */
  private async connectorOwnsOrderPaymentState(order: Order, ctPaymentId: string): Promise<boolean> {
    if (order.paymentState === OrderPaymentState.PENDING) {
      return true;
    }

    const payment = await this.ctPaymentService.getPayment({ id: ctPaymentId });
    return this.ctPaymentService.hasTransactionInState({
      payment,
      transactionType: 'Authorization',
      states: ['Pending'],
    });
  }

  /**
   * Issues `changePaymentState`, retrying once on a concurrent modification.
   *
   * commercetools requires the current `version` on every update and the SDK does NOT retry
   * optimistic-locking failures (ADR-003, ADR-007) — so a 409 needs a re-fetch for the fresh
   * version, not a replay of the same body. One retry is enough for the contention this path
   * actually sees (commercetools Checkout finishing its own order write); a retry loop would only
   * turn a systematic conflict into a slow one.
   */
  private async writeOrderPaymentState(
    order: Order,
    ctPaymentId: string,
    targetState: OrderPaymentState,
    eventType: string,
  ): Promise<void> {
    try {
      await this.postOrderPaymentState(order.id, order.version, targetState);
    } catch (writeError) {
      if (!isConcurrentModification(writeError)) {
        throw writeError;
      }

      // Re-resolve by the payment id we already hold, not via `order.paymentInfo` — an order can
      // reference several payments (a retried checkout), so picking `payments[0]` could re-fetch
      // by a sibling payment's id and, on a cart with more than one payment, resolve a different
      // order than the one we just tried to write.
      const fresh = await this.ctOrderService.getOrderByPaymentId({ paymentId: ctPaymentId });

      // Re-check against the state we just lost the race to. Whoever won may have resolved the
      // order already, and a blind replay would downgrade it — exactly what the guard exists to
      // prevent. Re-reading the fresh version without re-applying the guard is the subtle way to
      // reintroduce the bug.
      if (!shouldTransitionOrderPaymentState(fresh.paymentState, targetState)) {
        log.info('Order paymentState resolved by a concurrent write — leaving it as is', {
          orderId: fresh.id,
          currentPaymentState: fresh.paymentState ?? 'unset',
          targetPaymentState: targetState,
          eventType,
        });
        return;
      }

      await this.postOrderPaymentState(fresh.id, fresh.version, targetState);
    }

    log.info('Order paymentState updated', {
      orderId: order.id,
      targetPaymentState: targetState,
      eventType,
    });
  }

  private async postOrderPaymentState(
    orderId: string,
    version: number,
    paymentState: OrderPaymentState,
  ): Promise<void> {
    await paymentSDK.ctAPI.client
      .orders()
      .withId({ ID: orderId })
      .post({
        body: {
          version,
          actions: [{ action: 'changePaymentState', paymentState }],
        },
      })
      .execute();
  }

  /* istanbul ignore next: timer indirection exists so tests can stub the wait, not to be tested */
  private async delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Stores a payment method in commercetools when a customer opts to save it.
   *
   * This method is called from webhook handlers (payment_intent.succeeded or charge.succeeded)
   * to save payment methods that customers have chosen to reuse. It performs idempotent storage,
   * meaning it can be safely called multiple times for the same payment method without creating duplicates.
   *
   * The method:
   * 1. Extracts payment method and customer data from the webhook event
   * 2. Retrieves the payment method from Stripe to verify it's attached to a customer
   * 3. Saves the payment method to commercetools if it doesn't already exist
   * 4. Updates the payment record with the payment method token reference
   * 5. Creates a recurring payment job if the payment is linked to a recurring cart
   *
   * @param event - The Stripe webhook event (PAYMENT_INTENT__SUCCEEDED or CHARGE__SUCCEEDED)
   * @returns Promise that resolves when the payment method has been stored, or immediately if skipped
   */
  public async storePaymentMethod(event: Stripe.Event): Promise<void> {
    log.info('Storing payment method if opted-in by customer', { event: JSON.stringify(event.id) });

    try {
      const eventData = this.extractPaymentMethodDataFromEvent(event);
      if (!eventData) {
        log.info('No payment method or customer ID found in event metadata, skipping storage.', {
          eventId: event.id,
        });
        return;
      }

      const { stripePaymentMethodId, ctCustomerId, ctPaymentId } = eventData;
      const paymentMethod = await stripeApi().paymentMethods.retrieve(stripePaymentMethodId);

      if (!paymentMethod.customer) {
        log.info('Stripe payment method not attached to a customer, skipping storage', {
          paymentMethodId: stripePaymentMethodId,
        });
        return;
      }

      const ctPaymentMethod = await this.savePaymentMethodIfNew(paymentMethod, ctCustomerId);

      if (ctPaymentId) {
        await this.updatePaymentWithToken(ctPaymentId, paymentMethod);
        log.info('Updated payment with stored payment method token', {
          paymentId: ctPaymentId,
          paymentMethodId: ctPaymentMethod.id,
        });

        // Create a recurring payment job for the stored payment method if the payment is linked to a recurring cart
        const recurringPaymentJob = await this.ctRecurringPaymentJobService.createRecurringPaymentJobIfApplicable({
          originPayment: {
            id: ctPaymentId,
            typeId: 'payment',
          },
          paymentMethod: {
            id: ctPaymentMethod.id,
            typeId: 'payment-method',
          },
        });

        if (recurringPaymentJob) {
          log.info('Created recurring payment job for stored payment method', {
            recurringPaymentJobId: recurringPaymentJob.id,
            paymentMethodId: ctPaymentMethod.id,
          });
        }
      }
    } catch (e) {
      log.error('Error storing payment method in commercetools', { error: e, eventId: event.id });
      return;
    }
  }

  /**
   * Records a refund that Stripe ultimately rejected.
   *
   * ONLY the failed outcome reaches this method, and the asymmetry with `processStripeEventRefunded`
   * is deliberate rather than half-finished work. `charge.refunded` already writes Refund/Success,
   * so handling the success side here too would book the same refund twice. Failure, on the other
   * hand, is currently written NOWHERE: a refund Stripe later rejects stays recorded in
   * commercetools as successful forever, and the merchant sees money returned that never left.
   *
   * This matters far more on a delayed rail than on cards. A bank transfer refund is created
   * `pending` and resolves minutes to days later, so the Refund/Success that `charge.refunded`
   * writes is optimistic for that whole window. Moving Refund-transaction ownership to
   * `refund.updated` — which fires with the terminal status on every rail and is the natural single
   * owner — would change card behaviour too, so it is a separate decision and not taken here.
   *
   * Reads `ct_payment_id` off the refund's own metadata, stamped at `refunds.create`. Note this is
   * NOT the converter path: a Refund payload has no `ct_payment_id` at the location
   * `getCtPaymentId` reads, which is why this method builds its own update rather than going
   * through `StripeEventConverter`.
   */
  public async processStripeEventRefundFailed(event: Stripe.Event): Promise<void> {
    const refund = event.data.object as Stripe.Refund;
    log.info('Processing failed refund notification', { eventId: event.id, refundId: refund.id });

    try {
      const ctPaymentId = refund.metadata?.ct_payment_id;
      if (!ctPaymentId) {
        // Not an error: a Dashboard-issued refund legitimately carries no stamp, and there is
        // nothing to correct because nothing was written for it either. Named explicitly so an
        // operator investigating a missing correction is not left guessing.
        log.warn('Skipping failed refund: it carries no commercetools payment id in its metadata.', {
          refundId: refund.id,
          status: refund.status,
        });
        return;
      }

      await this.ctPaymentService.updatePayment({
        id: ctPaymentId,
        transaction: {
          type: PaymentTransactions.REFUND,
          state: PaymentStatus.FAILURE,
          amount: {
            // Verbatim integer cents from Stripe. No arithmetic, and deliberately not derived
            // from the payment's amountPlanned: a partial refund fails for its own amount.
            centAmount: refund.amount,
            currencyCode: refund.currency.toUpperCase(),
          },
          interactionId: refund.id,
        },
      });

      log.info('Refund marked as failed in commercetools.', {
        ctPaymentId,
        refundId: refund.id,
        status: refund.status,
        failureReason: refund.failure_reason,
      });
    } catch (e) {
      // Deliberately re-thrown, unlike processStripeEventRefunded's swallow (KI-001/KI-002).
      // Returning 200 after failing to write this correction would stop Stripe redelivering it,
      // and the payment would keep claiming a refund that never happened — the exact divergence
      // this method exists to close.
      //
      // Scalars only — see the note in processStripeEvent. Never pass the error object: Stripe
      // errors expose `raw`, `charge` and `payment_intent` as own enumerable properties and
      // winston serializes own enumerables.
      const err = e as Error & { type?: string; code?: string; statusCode?: number; httpErrorStatus?: number };
      log.error('Failed to record a failed refund in commercetools.', {
        refundId: refund.id,
        errorType: err.type ?? err.name,
        errorMessage: err.message,
        errorCode: err.code,
        errorStatus: err.statusCode ?? err.httpErrorStatus,
      });
      throw e;
    }
  }

  public async processStripeEventRefunded(event: Stripe.Event): Promise<void> {
    log.info('Processing notification', { event: JSON.stringify(event.id) });
    try {
      const updateData = this.stripeEventConverter.convert(event);
      const charge = event.data.object as Stripe.Charge;
      const refunds = await stripeApi().refunds.list({
        charge: charge.id,
        created: {
          gte: charge.created,
        },
        limit: 2,
      });

      const refund = refunds.data[0];
      if (!refund) {
        log.warn('No refund found for charge', { chargeId: charge.id });
        return;
      }

      updateData.pspReference = refund.id;
      updateData.transactions.forEach((tx) => {
        tx.interactionId = refund.id;
        tx.amount = {
          centAmount: refund.amount,
          currencyCode: refund.currency.toUpperCase(),
        };
      });

      for (const tx of updateData.transactions) {
        const updatedPayment = await this.ctPaymentService.updatePayment({
          ...updateData,
          transaction: tx,
        });

        log.info('Payment updated after processing the notification', {
          paymentId: updatedPayment.id,
          version: updatedPayment.version,
          pspReference: updateData.pspReference,
          paymentMethod: updateData.paymentMethod,
          transaction: JSON.stringify(tx),
        });
      }
    } catch (e) {
      // Scalars only — see the note in processStripeEvent. Never pass the error object.
      const err = e as Error & { type?: string; code?: string; statusCode?: number; httpErrorStatus?: number };
      log.error('Error processing notification', {
        eventId: event.id,
        eventType: event.type,
        errorType: err.type ?? err.name,
        errorMessage: err.message,
        errorCode: err.code,
        errorStatus: err.statusCode ?? err.httpErrorStatus,
      });
      return;
    }
  }

  public async processStripeEventMultipleCaptured(event: Stripe.Event): Promise<void> {
    log.info('Processing notification', { event: JSON.stringify(event.id) });
    try {
      const updateData = this.stripeEventConverter.convert(event);
      const charge = event.data.object as Stripe.Charge;
      if (charge.captured) {
        log.warn('Charge is already captured', { chargeId: charge.id });
        return;
      }

      const previousAttributes = event.data.previous_attributes as Stripe.Charge;
      if (!(charge.amount_captured > previousAttributes.amount_captured)) {
        log.warn('The amount captured do not change from the previous charge', { chargeId: charge.id });
        return;
      }

      updateData.pspReference = charge.balance_transaction as string;
      updateData.transactions.forEach((tx) => {
        tx.interactionId = charge.balance_transaction as string;
        tx.amount = {
          centAmount: charge.amount_captured - previousAttributes.amount_captured,
          currencyCode: charge.currency.toUpperCase(),
        };
      });

      for (const tx of updateData.transactions) {
        const updatedPayment = await this.ctPaymentService.updatePayment({
          ...updateData,
          transaction: tx,
        });

        log.info('Payment updated after processing the notification', {
          paymentId: updatedPayment.id,
          version: updatedPayment.version,
          pspReference: updateData.pspReference,
          paymentMethod: updateData.paymentMethod,
          transaction: JSON.stringify(tx),
        });
      }
    } catch (e) {
      // Scalars only — see the note in processStripeEvent. Never pass the error object.
      const err = e as Error & { type?: string; code?: string; statusCode?: number; httpErrorStatus?: number };
      log.error('Error processing notification', {
        eventId: event.id,
        eventType: event.type,
        errorType: err.type ?? err.name,
        errorMessage: err.message,
        errorCode: err.code,
        errorStatus: err.statusCode ?? err.httpErrorStatus,
      });
      return;
    }
  }

  public async retrieveOrCreateStripeCustomerId(cart: Cart, customer: Customer): Promise<string | undefined> {
    const savedCustomerId = customer?.custom?.fields?.[stripeCustomerIdFieldName];
    if (savedCustomerId) {
      const isValid = await this.validateStripeCustomerId(savedCustomerId, customer.id);
      if (isValid) {
        log.info('Customer has a valid Stripe Customer ID saved.', { stripeCustomerId: savedCustomerId });
        return savedCustomerId;
      }
    }

    const existingCustomer = await this.findStripeCustomer(customer.id);
    if (existingCustomer) {
      await this.saveStripeCustomerId(existingCustomer?.id, customer);

      return existingCustomer.id;
    }

    const newCustomer = await this.createStripeCustomer(cart, customer);
    if (newCustomer) {
      await this.saveStripeCustomerId(newCustomer?.id, customer);

      return newCustomer.id;
    } else {
      throw 'Failed to create stripe customer.';
    }
  }

  public async validateStripeCustomerId(stripeCustomerId: string, ctCustomerId: string): Promise<boolean> {
    try {
      const customer = await stripeApi().customers.retrieve(stripeCustomerId);
      return Boolean(customer && !customer.deleted && customer.metadata?.ct_customer_id === ctCustomerId);
    } catch (e) {
      log.warn('Error validating Stripe customer ID', { error: e });
      return false;
    }
  }

  public async findStripeCustomer(ctCustomerId: string): Promise<Stripe.Customer | undefined> {
    try {
      if (!isValidUUID(ctCustomerId)) {
        log.warn('Invalid ctCustomerId: Not a valid UUID:', { ctCustomerId });
        throw 'Invalid ctCustomerId: Not a valid UUID';
      }
      const query = `metadata['ct_customer_id']:'${ctCustomerId}'`;
      const customer = await stripeApi().customers.search({ query });

      return customer.data[0];
    } catch (e) {
      log.warn(`Error finding Stripe customer for ctCustomerId: ${ctCustomerId}`, { error: e });
      return undefined;
    }
  }

  public async createStripeCustomer(cart: Cart, customer: Customer): Promise<Stripe.Customer | undefined> {
    const shippingAddress = this.getStripeCustomerAddress(customer.addresses[0], cart.shippingAddress);
    const email = cart.customerEmail || customer.email || cart.shippingAddress?.email;
    return await stripeApi().customers.create({
      email,
      name: `${customer.firstName} ${customer.lastName}`.trim() || shippingAddress?.name,
      phone: shippingAddress?.phone,
      metadata: {
        ...(cart.customerId ? { ct_customer_id: customer.id } : null),
      },
      ...(shippingAddress?.address ? { address: shippingAddress.address } : null),
    });
  }

  public async saveStripeCustomerId(stripeCustomerId: string, customer: Customer): Promise<void> {
    /*
      TODO: commercetools insights on how to integrate the Stripe accountId into commercetools:
      We have plans to support recurring payments and saved payment methods in the next quarters.
      Not sure if you can wait until that so your implementation would be aligned with ours.
    */
    const fields: Record<string, string> = {
      [stripeCustomerIdFieldName]: stripeCustomerId,
    };
    const { id, version, custom } = customer;
    const updateFieldActions = await getCustomFieldUpdateActions({
      fields,
      customFields: custom,
      customType: stripeCustomerIdCustomType,
    });
    await updateCustomerById({ id, version, actions: updateFieldActions });
    log.info(`Stripe Customer ID "${stripeCustomerId}" saved to customer "${id}".`);
  }

  public async createSession(stripeCustomerId: string, cart: Cart): Promise<Stripe.CustomerSession | undefined> {
    const paymentConfig = getConfig().stripeSavedPaymentMethodConfig;
    const session = await stripeApi().customerSessions.create({
      customer: stripeCustomerId,
      components: {
        payment_element: {
          enabled: true,
          features: {
            ...paymentConfig,
            ...((this.ctCartService as any).isRecurringCart?.(cart) && {
              payment_method_save: 'enabled',
              payment_method_save_usage: 'off_session',
            }),
          },
        },
      },
    });

    return session;
  }

  public async createEphemeralKey(stripeCustomerId: string) {
    const config = getConfig();
    const stripe = stripeApi();
    const res = await stripe.ephemeralKeys.create(
      { customer: stripeCustomerId },
      { apiVersion: config.stripeApiVersion },
    );
    return res?.secret;
  }

  public async getCtCustomer(ctCustomerId: string): Promise<Customer | void> {
    return await paymentSDK.ctAPI.client
      .customers()
      .withId({ ID: ctCustomerId })
      .get()
      .execute()
      .then((response) => response.body)
      .catch((err) => {
        log.warn(`Customer not found ${ctCustomerId}`, { error: err });
        return;
      });
  }

  public getStripeCustomerAddress(prioritizedAddress: Address | undefined, fallbackAddress: Address | undefined) {
    if (!prioritizedAddress && !fallbackAddress) {
      return undefined;
    }

    const getField = (field: keyof Address): string => {
      const value = prioritizedAddress?.[field] ?? fallbackAddress?.[field];
      return typeof value === 'string' ? value : '';
    };

    return {
      name: `${getField('firstName')} ${getField('lastName')}`.trim(),
      phone: getField('phone') || getField('mobile'),
      address: {
        line1: `${getField('streetNumber')} ${getField('streetName')}`.trim(),
        line2: getField('additionalStreetInfo'),
        city: getField('city'),
        postal_code: getField('postalCode'),
        state: getField('state'),
        country: getField('country'),
      },
    };
  }

  public getBillingAddress(cart: Cart) {
    const prioritizedAddress = cart.billingAddress ?? cart.shippingAddress;
    if (!prioritizedAddress) {
      return undefined;
    }

    const getField = (field: keyof Address): string | null => {
      const value = prioritizedAddress?.[field as keyof typeof prioritizedAddress];
      return typeof value === 'string' ? value : '';
    };

    return JSON.stringify({
      name: `${getField('firstName')} ${getField('lastName')}`.trim(),
      phone: getField('phone') || getField('mobile'),
      email: cart.customerEmail ?? '',
      address: {
        line1: `${getField('streetNumber')} ${getField('streetName')}`.trim(),
        line2: getField('additionalStreetInfo'),
        city: getField('city'),
        postal_code: getField('postalCode'),
        state: getField('state'),
        country: getField('country'),
      },
    });
  }

  /**
   * Extracts payment method and customer data from Stripe webhook events.
   *
   * Supports both PAYMENT_INTENT__SUCCEEDED and CHARGE__SUCCEEDED events,
   * extracting the payment method ID, commercetools customer ID, and payment ID
   * from the event metadata.
   *
   * @param event - The Stripe webhook event
   * @returns Object containing extracted IDs, or null if required data is missing
   */
  private extractPaymentMethodDataFromEvent(event: Stripe.Event): {
    stripePaymentMethodId: string;
    ctCustomerId: string;
    ctPaymentId: string | null;
  } | null {
    let stripePaymentMethod: string | Stripe.PaymentMethod | null = null;
    let ctCustomerId: string | null = null;
    let ctPaymentId: string | null = null;

    if (event.type === StripeEvent.PAYMENT_INTENT__SUCCEEDED) {
      const paymentIntent = event.data.object as Stripe.PaymentIntent;
      stripePaymentMethod = paymentIntent.payment_method;
      ctCustomerId = paymentIntent.metadata?.ct_customer_id;
      ctPaymentId = paymentIntent.metadata?.ct_payment_id;
    } else if (event.type === StripeEvent.CHARGE__SUCCEEDED) {
      const charge = event.data.object as Stripe.Charge;
      stripePaymentMethod = charge.payment_method;
      ctCustomerId = charge.metadata?.ct_customer_id;
      ctPaymentId = charge.metadata?.ct_payment_id;
    }

    if (!stripePaymentMethod || !ctCustomerId) {
      return null;
    }

    return {
      stripePaymentMethodId: stripePaymentMethod as string,
      ctCustomerId,
      ctPaymentId,
    };
  }

  /**
   * Saves a Stripe payment method to commercetools if it doesn't already exist.
   *
   * Checks if the payment method token already exists for the customer to avoid
   * duplicates. This implements idempotent behavior - if called multiple times
   * with the same payment method, it will only be saved once.
   *
   * @param paymentMethod - The Stripe PaymentMethod object to save
   * @param ctCustomerId - The commercetools customer ID
   */
  private async savePaymentMethodIfNew(
    paymentMethod: Stripe.PaymentMethod,
    ctCustomerId: string,
  ): Promise<PaymentMethod> {
    try {
      const existingPaymentMethod = await this.ctPaymentMethodService.getByTokenValue({
        customerId: ctCustomerId,
        paymentInterface: getConfig().paymentInterface,
        tokenValue: paymentMethod.id,
      });

      if (existingPaymentMethod) {
        log.info('Payment method already stored for customer', {
          ctCustomerId,
          stripePaymentMethod: paymentMethod.id,
        });
        return existingPaymentMethod;
      }
    } catch (error) {
      if (error instanceof ErrorResourceNotFound) {
        log.debug('Payment method does not exist, will create new one', {
          ctCustomerId,
          stripePaymentMethod: paymentMethod.id,
        });
      } else {
        throw error;
      }
    }

    const ctPaymentMethod = await this.ctPaymentMethodService.save({
      customerId: ctCustomerId,
      paymentInterface: getConfig().paymentInterface,
      token: paymentMethod.id,
      method: paymentMethod.type,
    });

    log.info('Stored payment method for customer', {
      ctCustomerId,
      ctPaymentMethod: ctPaymentMethod.id,
      stripePaymentMethod: paymentMethod.id,
    });

    return ctPaymentMethod;
  }

  /**
   * Updates a commercetools payment with the saved payment method token.
   *
   * This associates the payment with the stored payment method, creating a
   * reference between the payment transaction and the reusable payment method.
   *
   * @param ctPaymentId - The commercetools payment ID to update
   * @param paymentMethod - The Stripe payment method to associate
   */
  private async updatePaymentWithToken(ctPaymentId: string, paymentMethod: Stripe.PaymentMethod): Promise<void> {
    const ctPayment = await this.ctPaymentService.updatePayment({
      id: ctPaymentId,
      ...({
        paymentMethodInfo: {
          token: {
            value: paymentMethod.id,
          },
        },
      } as any),
    });

    log.info('Updated commercetools payment with stored payment method token', {
      ctPaymentId: ctPayment.id,
    });
  }
}
