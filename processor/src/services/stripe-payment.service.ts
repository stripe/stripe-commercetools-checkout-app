import Stripe from 'stripe';
import {
  Cart,
  ErrorInvalidOperation,
  healthCheckCommercetoolsPermissions,
  statusHandler,
} from '@commercetools/connect-payments-sdk';
import { Customer } from '@commercetools/platform-sdk/dist/declarations/src/generated/models/customer';
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
import { getConfig } from '../config/config';
import { appLogger, paymentSDK } from '../payment-sdk';
import { CaptureMethod, StripePaymentServiceOptions } from './types/stripe-payment.type';
import {
  CollectBillingAddressOptions,
  ConfigElementResponseSchemaDTO,
  CustomerResponseSchemaDTO,
  PaymentOutcome,
  PaymentResponseSchemaDTO,
} from '../dtos/stripe-payment.dto';
import {
  getCartIdFromContext,
  getMerchantReturnUrlFromContext,
  getPaymentInterfaceFromContext,
} from '../libs/fastify/context/context';
import { stripeApi, wrapStripeError } from '../clients/stripe.client';
import { log } from '../libs/logger';
import crypto from 'crypto';
import { StripeEventConverter } from './converters/stripeEventConverter';
import { stripeCustomerIdCustomType, stripeCustomerIdFieldName } from '../custom-types/custom-types';
import { getCustomFieldUpdateActions } from '../services/commerce-tools/customTypeHelper';
import { Address } from '@commercetools/platform-sdk/dist/declarations/src/generated/models/common';
import { isValidUUID } from '../utils';
import { updateCustomerById } from '../services/commerce-tools/customerClient';

export class StripePaymentService extends AbstractPaymentService {
  private stripeEventConverter: StripeEventConverter;

  constructor(opts: StripePaymentServiceOptions) {
    super(opts.ctCartService, opts.ctPaymentService, opts.ctOrderService);
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
    };
  }

  /**
   * Capture payment in Stripe, supporting multicapture (multiple partial captures).
   *
   * @remarks
   * Supports capturing the total or a partial amount multiple times, as allowed by Stripe.
   *
   * @param {CapturePaymentRequest} request - Information about the ct payment and the amount.
   * @returns Promise with data containing operation status and PSP reference
   */
  public async capturePayment(request: CapturePaymentRequest): Promise<PaymentProviderModificationResponse> {
    try {
      const paymentIntentId = request.payment.interfaceId as string;
      const amountToBeCaptured = request.amount.centAmount;
      const stripePaymentIntent: Stripe.PaymentIntent = await stripeApi().paymentIntents.retrieve(paymentIntentId);

      if (!request.payment.amountPlanned.centAmount) {
        throw new Error('Payment amount is not set');
      }

      const cartTotalAmount = request.payment.amountPlanned.centAmount;
      const isPartialCapture = stripePaymentIntent.amount_received + amountToBeCaptured < cartTotalAmount;

      const response = await stripeApi().paymentIntents.capture(paymentIntentId, {
        amount_to_capture: amountToBeCaptured,
        ...(isPartialCapture && {
          final_capture: false,
        }),
      });

      log.info(`Payment modification completed.`, {
        paymentId: paymentIntentId,
        action: PaymentTransactions.CHARGE,
        result: PaymentModificationStatus.APPROVED,
        trackingId: response.id,
        isPartialCapture: isPartialCapture,
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
   * @param {RefundPaymentRequest} request - contains amount and {@link https://docs.commercetools.com/api/projects/payments | Payment } defined in composable commerce
   * @returns Promise with mocking data containing operation status and PSP reference
   */
  public async refundPayment(request: RefundPaymentRequest): Promise<PaymentProviderModificationResponse> {
    try {
      const paymentIntentId = request.payment.interfaceId as string;
      const amount = request.amount.centAmount;
      const response = await stripeApi().refunds.create({
        payment_intent: paymentIntentId,
        amount: amount,
      });

      log.info(`Payment modification completed.`, {
        paymentId: request.payment.id,
        action: PaymentTransactions.REFUND,
        result: PaymentModificationStatus.APPROVED,
        trackingId: response.id,
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

      const session = await this.createSession(stripeCustomerId);
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
   * Creates a payment intent using the Stripe API and create commercetools payment with Initial transaction.
   *
   * @return Promise<PaymentResponseSchemaDTO> A Promise that resolves to a PaymentResponseSchemaDTO object containing the client secret and payment reference.
   */
  public async createPaymentIntentStripe(): Promise<PaymentResponseSchemaDTO> {
    const config = getConfig();
    const ctCart = await this.ctCartService.getCart({ id: getCartIdFromContext() });
    const customer = await this.getCtCustomer(ctCart.customerId!);
    const shippingAddress = this.getStripeCustomerAddress(ctCart.shippingAddress, customer?.addresses[0]);
    const amountPlanned = await this.ctCartService.getPaymentAmount({ cart: ctCart });
    const captureMethodConfig = config.stripeCaptureMethod;
    const merchantReturnUrl = getMerchantReturnUrlFromContext() || config.merchantReturnUrl;
    const setupFutureUsage = config.stripeSavedPaymentMethodConfig?.payment_method_save_usage;
    const stripeCustomerId = customer?.custom?.fields?.[stripeCustomerIdFieldName];

    let paymentIntent!: Stripe.PaymentIntent;

    try {
      const idempotencyKey = crypto.randomUUID();
      paymentIntent = await stripeApi().paymentIntents.create(
        {
          ...(stripeCustomerId && {
            customer: stripeCustomerId,
            setup_future_usage: setupFutureUsage,
          }),
          amount: amountPlanned.centAmount,
          currency: amountPlanned.currencyCode,
          automatic_payment_methods: {
            enabled: true,
          },
          capture_method: captureMethodConfig as CaptureMethod,
          metadata: {
            cart_id: ctCart.id,
            ct_project_key: config.projectKey,
            ...(ctCart.customerId ? { ct_customer_id: ctCart.customerId } : null),
          },
          shipping: shippingAddress,
          payment_method_options: {
            card: {
              request_multicapture: 'if_available',
            },
          },
        },
        {
          idempotencyKey,
        },
      );
    } catch (e) {
      throw wrapStripeError(e);
    }

    log.info(`Stripe PaymentIntent created.`, {
      ctCartId: ctCart.id,
      stripePaymentIntentId: paymentIntent.id,
    });

    const ctPayment = await this.ctPaymentService.createPayment({
      amountPlanned,
      paymentMethodInfo: {
        paymentInterface: getPaymentInterfaceFromContext() || 'stripe',
        /*name: { // Currently unused fields
          en: 'Stripe Payment Connector',
        },*/
      },
      /*paymentStatus: { // Currently unused fields
        interfaceCode: paymentIntent.id, //This is translated to PSP Status Code on the Order->Payment page
        interfaceText: paymentIntent.description || '', //This is translated to Description on the Order->Payment page
      },*/
      ...(ctCart.customerId && {
        customer: {
          typeId: 'customer',
          id: ctCart.customerId,
        },
      }),
      ...(!ctCart.customerId &&
        ctCart.anonymousId && {
          anonymousId: ctCart.anonymousId,
        }),
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

    try {
      const idempotencyKey = crypto.randomUUID();
      await stripeApi().paymentIntents.update(
        paymentIntent.id,
        {
          metadata: {
            ct_payment_id: ctPayment.id,
          },
        },
        { idempotencyKey },
      );
    } catch (e) {
      throw wrapStripeError(e);
    }

    log.info(`Stripe update Payment id metadata.`);

    return {
      sClientSecret: paymentIntent.client_secret ?? '',
      paymentReference: ctPayment.id,
      merchantReturnUrl: merchantReturnUrl,
      cartId: ctCart.id,
      ...(config.stripeCollectBillingAddress !== 'auto' && {
        billingAddress: this.getBillingAddress(ctCart),
      }),
    };
  }

  /**
   * Update the PaymentIntent in Stripe to mark the Authorization in commercetools as successful.
   *
   * @param {string} paymentIntentId - The Intent id created in Stripe.
   * @param {string} paymentReference - The identifier of the payment associated with the PaymentIntent in Stripe.
   * @return {Promise<void>} - A Promise that resolves when the PaymentIntent is successfully updated.
   */
  public async updatePaymentIntentStripeSuccessful(paymentIntentId: string, paymentReference: string): Promise<void> {
    const ctCart = await this.ctCartService.getCart({
      id: getCartIdFromContext(),
    });

    const ctPayment = await this.ctPaymentService.getPayment({
      id: paymentReference,
    });
    const amountPlanned = ctPayment.amountPlanned;

    log.info(`PaymentIntent confirmed.`, {
      ctCartId: ctCart.id,
      stripePaymentIntentId: ctPayment.interfaceId,
      amountPlanned: JSON.stringify(amountPlanned),
    });

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
      stripeSavedPaymentMethodConfig,
      stripeLayout,
      stripeCollectBillingAddress,
    } = getConfig();
    const ctCart = await this.ctCartService.getCart({ id: getCartIdFromContext() });
    const amountPlanned = await this.ctCartService.getPaymentAmount({ cart: ctCart });
    const appearance = stripePaymentElementAppearance;
    const setupFutureUsage = stripeSavedPaymentMethodConfig.payment_method_save_usage!;

    log.info(`Cart and Stripe.Element ${opts} config retrieved.`, {
      cartId: ctCart.id,
      cartInfo: {
        amount: amountPlanned.centAmount,
        currency: amountPlanned.currencyCode,
      },
      stripeElementAppearance: appearance,
      stripeCaptureMethod: stripeCaptureMethod,
      stripeSetupFutureUsage: setupFutureUsage,
      layout: stripeLayout,
      collectBillingAddress: stripeCollectBillingAddress,
    });

    return {
      cartInfo: {
        amount: amountPlanned.centAmount,
        currency: amountPlanned.currencyCode,
      },
      appearance: appearance,
      captureMethod: stripeCaptureMethod,
      setupFutureUsage: setupFutureUsage,
      layout: stripeLayout,
      collectBillingAddress: stripeCollectBillingAddress as CollectBillingAddressOptions,
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
  public async processStripeEvent(event: Stripe.Event): Promise<void> {
    log.info('Processing notification', { event: JSON.stringify(event.id) });
    try {
      const updateData = this.stripeEventConverter.convert(event);

      //does payment intent event have multicapture?
      if (event.type.startsWith('payment')) {
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
      log.error('Error processing notification', { error: e });
      return;
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
      log.error('Error processing notification', { error: e });
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
      log.error('Error processing notification', { error: e });
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

  public async createSession(stripeCustomerId: string): Promise<Stripe.CustomerSession | undefined> {
    const paymentConfig = getConfig().stripeSavedPaymentMethodConfig;
    const session = await stripeApi().customerSessions.create({
      customer: stripeCustomerId,
      components: {
        payment_element: {
          enabled: true,
          features: { ...paymentConfig },
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
      const value = prioritizedAddress?.[field];
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
}
