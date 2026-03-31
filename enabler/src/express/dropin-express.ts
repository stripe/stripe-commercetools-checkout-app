import {
  PaymentExpressBuilder,
  ExpressOptions,
  ExpressComponent,
  ExpressAddressData,
  ExpressPaymentSubmitPayload,
  InitialPaymentData,
} from '../payment-enabler/payment-enabler';
import { BaseOptions } from '../payment-enabler/payment-enabler-mock';
import { DefaultExpressComponent } from './base';
import {
  LineItem,
  StripeExpressCheckoutElement,
  StripeExpressCheckoutElementClickEvent,
} from '@stripe/stripe-js';
import { PaymentResponseSchemaDTO } from '../dtos/mock-payment.dto';

interface BillingAddress {
  name: string;
  email: string;
  phone: string;
  address: {
    city: string;
    country: string;
    line1: string;
    line2: string;
    postal_code: string;
    state: string;
  };
}

interface ConfirmPaymentProps {
  merchantReturnUrl: string;
  cartId: string;
  clientSecret: string;
  paymentReference: string;
  billingAddress?: BillingAddress;
}

interface ConfirmPaymentIntentProps {
  paymentIntentId: string;
  paymentReference: string;
}

export class StripeExpressBuilder implements PaymentExpressBuilder {
  private baseOptions: BaseOptions;

  constructor(baseOptions: BaseOptions) {
    this.baseOptions = baseOptions;
  }

  build(config: ExpressOptions): StripeExpressComponent {
    const component = new StripeExpressComponent({
      baseOptions: this.baseOptions,
      expressOptions: config,
    });
    return component;
  }
}

export class StripeExpressComponent extends DefaultExpressComponent implements ExpressComponent {
  private baseOptions: BaseOptions;
  private expressCheckoutElement: StripeExpressCheckoutElement | null = null;
  private currentSessionId: string;
  /**
   * Session id from the enabler constructor; used when resetting before a new `onPayButtonClick` completes
   * and after the buyer dismisses the Express modal ({@link resetExpressSessionState}).
   */
  private readonly initialSessionId: string;
  /** In-flight `onPayButtonClick` from the latest Express `click`; awaited by {@link ensureSessionId}. */
  private sessionInitPromise: Promise<void> | null = null;
  /**
   * Incremented on each Express `click` and in {@link resetExpressSessionState}; stale async completions are ignored.
   */
  private sessionInitGeneration = 0;
  private expressListenersBound = false;
  private expressMounted = false;

  constructor(opts: { baseOptions: BaseOptions; expressOptions: ExpressOptions }) {
    super({ expressOptions: opts.expressOptions });
    this.baseOptions = opts.baseOptions;
    this.initialSessionId = opts.baseOptions.sessionId ?? '';
    this.currentSessionId = this.initialSessionId;
  }

  /**
   * Drops in-flight session initialization and restores {@link currentSessionId} to {@link initialSessionId}.
   * Invoked when the buyer cancels Express Checkout so the next wallet open runs a fresh {@link ExpressOptions.onPayButtonClick}.
   */
  private resetExpressSessionState(): void {
    this.sessionInitGeneration += 1;
    this.sessionInitPromise = null;
    this.currentSessionId = this.initialSessionId;
  }

  async init(): Promise<void> {
    if (!this.baseOptions.elements) {
      throw new Error('Stripe Elements not initialized');
    }

    // Mount renders the button; session is refreshed on each Stripe `click` (async) and via `ensureSessionId` fallback.
    // Amount/currency belong on the Elements instance, not on expressCheckout options (Stripe API).
    const { centAmount, currencyCode } = this.expressOptions.initialAmount;
    const currency = currencyCode.toLowerCase();
    this.baseOptions.elements.update({
      amount: centAmount,
      ...(currency && { currency }),
    });

    // expressCheckout element only accepts layout, buttonTheme, and shipping/billing collection options (not amount/currency).
    const createElement = this.baseOptions.elements.create as any;
    this.expressCheckoutElement = createElement('expressCheckout', {
      shippingAddressRequired: true,
      billingAddressRequired: true,
    }) as StripeExpressCheckoutElement;
  }

  async mount(selector: string): Promise<void> {
    if (!this.expressCheckoutElement) {
      await this.init();
    }

    if (!this.expressCheckoutElement) {
      const error = new Error('Failed to initialize Express Checkout element.');
      this.baseOptions.onError?.(error);
      throw error;
    }

    if (this.expressMounted) {
      this.expressCheckoutElement.unmount();
    }
    this.expressCheckoutElement.mount(selector);
    this.expressMounted = true;

    if (!this.expressListenersBound) {
      this.bindExpressEventListeners();
      this.expressListenersBound = true;
    }
  }

  /**
   * Line items for Stripe `click` `resolve` from checkout-known total (must stay synchronous for Stripe time limit).
   */
  private getResolveLineItemsFromInitial(): LineItem[] {
    const { centAmount } = this.expressOptions.initialAmount;
    return [{ name: 'Total', amount: centAmount }];
  }

  /**
   * Refreshes the commercetools Connect session from {@link ExpressOptions.onPayButtonClick} without blocking
   * Stripe's `click` `resolve` (~1s constraint). Each wallet open resets to {@link initialSessionId}
   * until the callback resolves; overlapping async work is dropped via {@link sessionInitGeneration}.
   */
  private kickOffSessionInitFromClick(): void {
    this.sessionInitGeneration += 1;
    const gen = this.sessionInitGeneration;
    this.currentSessionId = this.initialSessionId;

    this.sessionInitPromise = (async () => {
      try {
        const { sessionId } = await this.expressOptions.onPayButtonClick();
        if (gen !== this.sessionInitGeneration) return;
        this.currentSessionId = sessionId;
      } catch {
        if (gen === this.sessionInitGeneration) {
          this.baseOptions.onError?.(new Error('Failed to get session ID for Express Checkout.'));
        }
      } finally {
        if (gen === this.sessionInitGeneration) {
          this.sessionInitPromise = null;
        }
      }
    })();
  }

  private bindExpressEventListeners(): void {
    const el = this.expressCheckoutElement;
    if (!el) return;

    el.on('click', (event: StripeExpressCheckoutElementClickEvent) => {
      event.resolve({
        lineItems: this.getResolveLineItemsFromInitial(),
      });
      this.kickOffSessionInitFromClick();
    });

    el.on('confirm', async () => {
      await this.handlePaymentConfirm();
    });

    el.on('cancel', () => {
      this.handleCancel();
    });

    el.on('shippingaddresschange', async (event) => {
      await this.handleShippingAddressChange(event);
    });

    el.on('shippingratechange', async (event) => {
      await this.handleShippingRateChange(event);
    });
  }

  /**
   * Fetches the current cart total and line items from the processor for the active session.
   * Called after shipping address or shipping method changes so Elements and Stripe resolve use the correct amount.
   *
   * @returns {Promise<InitialPaymentData>} Total, line items, and currency from the processor.
   * @throws {Error} When the processor response is not successful.
   */
  private async getInitialPaymentData(): Promise<InitialPaymentData> {
    const apiUrl = new URL(`${this.baseOptions.processorUrl}/express-payment-data`);
    const response = await fetch(apiUrl.toString(), {
      method: 'GET',
      headers: this.getHeadersConfig(),
    });

    if (!response.ok) {
      throw new Error('Failed to get express amount from processor');
    }

    const data = await response.json();
    return data as InitialPaymentData;
  }

  /**
   * Ensures we have a session ID for the Processor (`x-session-id`).
   * Awaits the in-flight promise from the latest Express `click` when present; otherwise calls {@link ExpressOptions.onPayButtonClick}.
   */
  private async ensureSessionId(): Promise<void> {
    if (this.sessionInitPromise) {
      try {
        await this.sessionInitPromise;
      } catch {
        throw new Error('Failed to get sessionId from onPayButtonClick');
      }
    }

    if (this.currentSessionId) return;

    try {
      const { sessionId } = await this.expressOptions.onPayButtonClick();
      this.currentSessionId = sessionId;
    } catch {
      this.baseOptions.onError?.(new Error('Failed to get session ID for Express Checkout.'));
      throw new Error('Failed to get sessionId from onPayButtonClick');
    }
  }

  /**
   * Handles the Stripe Express `shippingaddresschange` event: updates the cart shipping address,
   * loads shipping methods, applies the first rate by default, fetches totals/line items from the processor,
   * updates Elements, and resolves the event for Stripe.
   *
   * @param event - Stripe event with `address`, `resolve`, and `reject`.
   */
  private async handleShippingAddressChange(event: any): Promise<void> {
    const { address: stripeAddress, resolve, reject } = event;
    try {
      await this.ensureSessionId();
      const expressAddress = this.convertToExpressAddress(stripeAddress);

      await this.setShippingAddress({ address: expressAddress });

      const shippingMethods = await this.getShippingMethods({
        address: expressAddress,
      });

      if (this.expressCheckoutElement && shippingMethods.length > 0) {
        const shippingRates = shippingMethods.map((method) => ({
          id: method.id,
          displayName: method.name || method.id,
          amount: method.amount?.centAmount || 0,
          currency: method.amount?.currencyCode?.toLowerCase() || 'usd',
        }));

        // Apply first shipping rate by default so Order Total updates even when shippingratechange does not fire
        const firstRate = shippingRates[0];
        await this.setShippingMethod({ shippingMethod: { id: firstRate.id } });
        const data = await this.getInitialPaymentData();
        await this.baseOptions.elements.update({ amount: data.totalPrice.centAmount });
        const lineItemsForStripe = data.lineItems.map((item) => ({ name: item.name, amount: item.amount.centAmount }));
        resolve({ shippingRates, lineItems: lineItemsForStripe });
      } else {
        reject();
      }
    } catch (error) {
      this.baseOptions.onError?.(new Error('Error updating shipping address.'));
      reject();
      throw error;
    }
  }

  /**
   * Handles the Stripe Express `shippingratechange` event: updates the cart shipping method,
   * refreshes amount and line items from the processor, updates Elements, and resolves for Stripe.
   *
   * @param event - Stripe event with `shippingRate`, `resolve`, and `reject`.
   */
  private async handleShippingRateChange(event: any): Promise<void> {
    const { shippingRate: stripeShippingRate, resolve, reject } = event;
    try {
      await this.setShippingMethod({
        shippingMethod: {
          id: stripeShippingRate.id,
        },
      });

      const data = await this.getInitialPaymentData();
      await this.baseOptions.elements.update({
        amount: data.totalPrice.centAmount,
      });
      const lineItemsForStripe = data.lineItems.map((item) => ({ name: item.name, amount: item.amount.centAmount }));
      resolve({ lineItems: lineItemsForStripe });
    } catch (error) {
      this.baseOptions.onError?.(new Error('Error updating shipping method.'));
      reject();
      throw error;
    }
  }

  /**
   * Handles the cancel event when the user dismisses the Express Checkout modal.
   * Resets session state for the next open, then signals cancellation via {@link BaseOptions.onError}
   * with an error whose {@link Error.name} is `'CANCEL'`, following the commercetools Connect standard.
   */
  private handleCancel(): void {
    this.resetExpressSessionState();
    const cancelError = new Error('Express Checkout cancelled by user.');
    cancelError.name = 'CANCEL';
    this.baseOptions.onError?.(cancelError);
  }

  /**
   * Builds the optional cart-sync payload for {@link ExpressOptions.onPaymentSubmit}.
   * Omits `shippingAddress` / `billingAddress` unless a trimmed country is present, and omits
   * `customerEmail` when blank, so integrators never receive empty address objects that map to
   * invalid cart updates while a shipping method is set.
   *
   * @param expressShipping - Shipping address in {@link ExpressAddressData} shape (may be empty).
   * @param expressBilling - Billing address in {@link ExpressAddressData} shape (may be empty).
   * @param customerEmail - Email from billing or shipping conversion.
   * @returns A non-empty {@link ExpressPaymentSubmitPayload}, or `null` when nothing should be synced.
   */
  private buildExpressPaymentSubmitPayload(
    expressShipping: ExpressAddressData,
    expressBilling: ExpressAddressData,
    customerEmail: string,
  ): ExpressPaymentSubmitPayload | null {
    const email = customerEmail?.trim() ?? '';
    const hasShipping = Boolean(expressShipping?.country?.trim());
    const hasBilling = Boolean(expressBilling?.country?.trim());
    const hasEmail = Boolean(email);

    if (!hasShipping && !hasBilling && !hasEmail) {
      return null;
    }

    return {
      ...(hasShipping ? { shippingAddress: expressShipping } : {}),
      ...(hasBilling ? { billingAddress: expressBilling } : {}),
      ...(hasEmail ? { customerEmail: email } : {}),
    };
  }

  /**
   * Handles payment confirmation when the user authorizes payment in Express Checkout.
   * Triggered by the `confirm` event from `StripeExpressCheckoutElement`.
   *
   * @remarks
   * Flow: submit Elements → optional sync via `onPaymentSubmit` (partial payload only) →
   * create PaymentIntent on the processor → confirm with Stripe → persist in commercetools → `onComplete`.
   */
  private async handlePaymentConfirm(): Promise<void> {
    try {
      await this.ensureSessionId();

      // Step 1: Submit Elements (payment method is already authorized in Elements).
      const { error: submitError } = await this.baseOptions.elements.submit();

      if (submitError) {
        throw submitError;
      }

      // Step 2: Read shipping/billing from the Express element when Stripe exposes them.
      let shippingAddress: any = null;
      let billingAddress: any = null;
      try {
        shippingAddress = this.getShippingAddressFromStripe();
        billingAddress = this.getBillingAddressFromStripe();
      } catch {
        // Element may not expose addresses; cart may already be updated from prior shipping events.
      }

      // Step 3: Integrator callback — sync checkout/cart only for fields the wallet exposed.
      const expressShipping = shippingAddress
        ? this.convertToExpressAddress(shippingAddress)
        : ({} as ExpressAddressData);
      const expressBilling = billingAddress
        ? this.convertToExpressAddress(billingAddress)
        : ({} as ExpressAddressData);
      const customerEmail = expressBilling?.email ?? expressShipping?.email ?? '';
      const paymentSubmitPayload = this.buildExpressPaymentSubmitPayload(
        expressShipping,
        expressBilling,
        customerEmail,
      );
      if (paymentSubmitPayload) {
        await this.expressOptions.onPaymentSubmit(paymentSubmitPayload);
      }

      // Step 4: Create PaymentIntent via processor (same GET /payments path as embedded drop-in).
      const paymentRes = await this.getPayment();

      // Step 5: Confirm PaymentIntent with Stripe; `paymentMethod` comes from Elements.
      const { paymentIntent } = await this.confirmStripePayment({
        merchantReturnUrl: paymentRes.merchantReturnUrl,
        cartId: paymentRes.cartId,
        clientSecret: paymentRes.sClientSecret,
        paymentReference: paymentRes.paymentReference,
        ...(billingAddress && {
          billingAddress: this.convertStripeAddressToBillingAddress(billingAddress),
        }),
      });

      // Step 6: Confirm in commercetools (processor `/confirmPayments`).
      await this.confirmPaymentIntent({
        paymentIntentId: paymentIntent.id,
        paymentReference: paymentRes.paymentReference,
      });

      // Step 7: Notify host checkout of success.
      this.expressOptions.onComplete?.({
        isSuccess: true,
        paymentReference: paymentRes.paymentReference,
      });
    } catch (error) {
      this.baseOptions.onError?.(new Error('Error during payment confirmation.'));
      this.expressOptions.onComplete?.({
        isSuccess: false,
      });
    }
  }


  /**
   * Requests PaymentIntent details from the processor.
   *
   * @remarks
   * Uses `GET /payments` — the same endpoint as the embedded drop-in flow.
   * Sends `x-session-id` from `currentSessionId` (from enabler, `click` + `onPayButtonClick`, or `ensureSessionId` fallback).
   */
  private async getPayment(): Promise<PaymentResponseSchemaDTO> {
    const apiUrl = new URL(`${this.baseOptions.processorUrl}/payments`);
    const response = await fetch(apiUrl.toString(), {
      method: 'GET',
      headers: this.getHeadersConfig(),
    });

    if (!response.ok) {
      const error = await response.json();
      throw error;
    }

    return await response.json();
  }

  /**
   * Confirms the PaymentIntent with Stripe using the shared Elements instance.
   *
   * @remarks
   * The authorized `paymentMethod` is taken from Elements; optional `billingAddress` augments `confirmParams`.
   */
  private async confirmStripePayment({
    merchantReturnUrl,
    cartId,
    clientSecret,
    paymentReference,
    billingAddress,
  }: ConfirmPaymentProps) {
    const returnUrl = new URL(merchantReturnUrl);
    returnUrl.searchParams.append('cartId', cartId);
    returnUrl.searchParams.append('paymentReference', paymentReference);

    const { error, paymentIntent } = await this.baseOptions.sdk.confirmPayment({
      elements: this.baseOptions.elements, // PaymentMethod comes from elements (already authorized)
      clientSecret,
      confirmParams: {
        return_url: returnUrl.toString(),
        ...(billingAddress && {
          payment_method_data: {
            billing_details: billingAddress,
          },
        }),
      },
      redirect: 'if_required',
    });

    if (error) {
      throw error;
    }

    if (paymentIntent.status === 'requires_action') {
      const error: any = new Error('Payment requires additional action');
      error.type = 'requires_action';
      error.next_action = paymentIntent.next_action;
      throw error;
    }

    if (paymentIntent.last_payment_error) {
      const error: any = new Error(`${paymentIntent.last_payment_error.message}`);
      error.type = 'payment_failed';
      error.last_payment_error = paymentIntent.last_payment_error;
      throw error;
    }

    return { paymentIntent };
  }

  /**
   * Notifies the processor that the PaymentIntent succeeded so commercetools can be updated.
   *
   * @param paymentIntentId - Stripe PaymentIntent id.
   * @param paymentReference - CT payment reference from the processor payment response.
   */
  private async confirmPaymentIntent({
    paymentIntentId,
    paymentReference,
  }: ConfirmPaymentIntentProps) {
    const apiUrl = `${this.baseOptions.processorUrl}/confirmPayments/${paymentReference}`;
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: this.getHeadersConfig(),
      body: JSON.stringify({ paymentIntent: paymentIntentId }),
    });

    if (!response.ok) {
      throw new Error('Error on /confirmPayments');
    }

    this.baseOptions.onComplete?.({ isSuccess: true, paymentReference });
  }

  /**
   * Builds headers for enabler → processor requests.
   *
   * @returns Headers including `Content-Type`, `x-session-id` (`currentSessionId`), and optional `x-express-checkout`.
   */
  private getHeadersConfig(): HeadersInit {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'x-session-id': this.currentSessionId,
    };
    if (this.baseOptions.expressCheckout) {
      headers['x-express-checkout'] = 'true';
    }
    return headers;
  }

  /**
   * Gets shipping address from Stripe ExpressCheckoutElement.
   * This is available after the user selects an address in the Express Checkout modal.
   */
  private getShippingAddressFromStripe(): any {
    // Access the last shipping address from the element
    // Note: This is an internal property that may not be in type definitions
    const value = (this.expressCheckoutElement as any)?._lastShippingAddress ||
      (this.expressCheckoutElement as any)?.lastShippingAddress ||
      null;
    return value;
  }

  /**
   * Gets billing address from Stripe ExpressCheckoutElement.
   * This is available after the user authorizes payment.
   */
  private getBillingAddressFromStripe(): any {
    // Access the last billing address from the element
    // Note: This is an internal property that may not be in type definitions
    const value = (this.expressCheckoutElement as any)?._lastBillingAddress ||
      (this.expressCheckoutElement as any)?.lastBillingAddress ||
      null;
    return value;
  }

  /**
   * Converts Stripe address format to BillingAddress format for confirmPayment.
   */
  private convertStripeAddressToBillingAddress(stripeAddress: any): BillingAddress {
    const address = stripeAddress.address || {};
    return {
      name: stripeAddress.name || '',
      email: stripeAddress.email || '',
      phone: stripeAddress.phone || '',
      address: {
        city: address.city || '',
        country: address.country || '',
        line1: address.line1 || '',
        line2: address.line2 || '',
        postal_code: address.postal_code || '',
        state: address.state || '',
      },
    };
  }

  /**
   * Converts a Stripe address payload to {@link ExpressAddressData} for CT/checkout callbacks.
   *
   * @param stripeAddress - Nested `{ address: { ... } }` or flat `{ country, line1, ... }` from Stripe.
   */
  private convertToExpressAddress(stripeAddress: any): ExpressAddressData {
    const address = stripeAddress?.address ?? stripeAddress ?? {};
    const nameParts = stripeAddress?.name ? stripeAddress.name.split(' ') : [];
    const firstName = nameParts[0] || '';
    const lastName = nameParts.slice(1).join(' ') || '';

    return {
      country: address.country || '',
      city: address.city || undefined,
      postalCode: address.postal_code || undefined,
      state: address.state || undefined,
      streetName: address.line1 ? address.line1.split(' ').slice(1).join(' ') : undefined,
      streetNumber: address.line1 ? address.line1.split(' ')[0] : undefined,
      additionalStreetInfo: address.line2 || undefined,
      firstName: firstName || undefined,
      lastName: lastName || undefined,
      phone: stripeAddress?.phone || undefined,
      email: stripeAddress?.email || undefined,
    };
  }
}
