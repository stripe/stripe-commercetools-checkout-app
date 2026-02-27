import {
  PaymentExpressBuilder,
  ExpressOptions,
  ExpressComponent,
  ExpressAddressData,
  CTAmount,
} from '../payment-enabler/payment-enabler';
import { BaseOptions } from '../payment-enabler/payment-enabler-mock';
import { DefaultExpressComponent } from './base';
import { StripeExpressCheckoutElement } from '@stripe/stripe-js';
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

  constructor(opts: { baseOptions: BaseOptions; expressOptions: ExpressOptions }) {
    super({ expressOptions: opts.expressOptions });
    this.baseOptions = opts.baseOptions;
    this.currentSessionId = opts.baseOptions.sessionId;
  }

  async init(): Promise<void> {
    if (!this.baseOptions.elements) {
      throw new Error('Stripe Elements not initialized');
    }

    // Call onPayButtonClick to get sessionId (as per template requirement)
    try {
      const { sessionId } = await this.expressOptions.onPayButtonClick();
      this.currentSessionId = sessionId;
    } catch (error) {
      this.baseOptions.onError?.(new Error('Failed to get session ID for Express Checkout.'));
      throw new Error('Failed to get sessionId from onPayButtonClick');
    }

    // Use type assertion since expressCheckout may not be in the type definitions yet
    // Cast elements.create to any to bypass type checking for expressCheckout
    const createElement = this.baseOptions.elements.create as any;
    this.expressCheckoutElement = createElement('expressCheckout', {
      amount: this.expressOptions.initialAmount.centAmount,
      currency: this.expressOptions.initialAmount.currencyCode.toLowerCase(),
      shippingAddressRequired: true,
      billingAddressRequired: true,
    }) as StripeExpressCheckoutElement;
  }

  async mount(selector: string): Promise<void> {
    if (!this.expressCheckoutElement) {
      await this.init();
    }

    if (this.expressCheckoutElement) {
      this.expressCheckoutElement.mount(selector);
      
      // Register "confirm" event handler - fired when user authorizes payment
      (this.expressCheckoutElement as any).on('confirm', async () => {
        await this.handlePaymentConfirm();
      });

      // Register "cancel" event handler - fired when user cancels Express Checkout modal
      (this.expressCheckoutElement as any).on('cancel', async () => {
        await this.handleCancel();
      });

      // Shipping address change (documented Stripe API)
      (this.expressCheckoutElement as any).on('shippingaddresschange', async (event: any) => {
        await this.handleShippingAddressChange(event);
      });

      // Shipping rate change (documented Stripe API)
      (this.expressCheckoutElement as any).on('shippingratechange', async (event: any) => {
        await this.handleShippingRateChange(event);
      });
    } else {
      const error = new Error('Failed to initialize Express Checkout element.');
      this.baseOptions.onError?.(error);
      throw error;
    }
  }

  /**
   * Returns the subtotal to use when updating amount/lineItems.
   * Uses getCurrentCartSubtotal if provided, otherwise initialAmount.
   */
  private async getSubtotalForAmountUpdate(): Promise<CTAmount> {
    if (this.expressOptions.getCurrentCartSubtotal) {
      return await this.expressOptions.getCurrentCartSubtotal();
    }
    return this.expressOptions.initialAmount;
  }

  private async handleShippingAddressChange(event: any): Promise<void> {
    const { address: stripeAddress, resolve, reject } = event;
    try {
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
        const currentSubtotal = await this.getSubtotalForAmountUpdate();
        const firstShippingAmount = firstRate.amount ?? 0;
        const defaultTotalCents = currentSubtotal.centAmount + firstShippingAmount;
        await this.baseOptions.elements.update({ amount: defaultTotalCents });
        const lineItems: Array<{ name: string; amount: number }> = [
          { name: 'Subtotal', amount: currentSubtotal.centAmount },
          { name: firstRate.displayName ?? 'Shipping', amount: firstShippingAmount },
        ];

        resolve({ shippingRates, lineItems });
      } else {
        resolve({ shippingRates: [] });
      }
    } catch (error) {
      this.baseOptions.onError?.(new Error('Error updating shipping address.'));
      reject();
      throw error;
    }
  }

  private async handleShippingRateChange(event: any): Promise<void> {
    const { shippingRate: stripeShippingRate, resolve, reject } = event;
    try {
      await this.setShippingMethod({
        shippingMethod: {
          id: stripeShippingRate.id,
        },
      });

      const currentSubtotal = await this.getSubtotalForAmountUpdate();
      const shippingAmount = stripeShippingRate.amount ?? 0;
      const estimatedNewAmount = {
        centAmount: currentSubtotal.centAmount + shippingAmount,
        currencyCode: currentSubtotal.currencyCode,
        fractionDigits: currentSubtotal.fractionDigits,
      };

      await this.baseOptions.elements.update({
        amount: estimatedNewAmount.centAmount,
      });

      const updatedLineItems: Array<{ name: string; amount: number }> = [
        { name: 'Subtotal', amount: currentSubtotal.centAmount },
        {
          name: stripeShippingRate.displayName ?? 'Shipping',
          amount: shippingAmount,
        },
      ];

      if (this.expressOptions.onAmountUpdated) {
        try {
          await this.expressOptions.onAmountUpdated(estimatedNewAmount);
        } catch {
          // ignore callback errors
        }
      }

      resolve({ lineItems: updatedLineItems });
    } catch (error) {
      this.baseOptions.onError?.(new Error('Error updating shipping method.'));
      reject();
      throw error;
    }
  }

  /**
   * Handles the cancel event when user cancels Express Checkout modal.
   * This allows Checkout to revert any shipping changes.
   */
  private async handleCancel(): Promise<void> {
    try {
      if (this.expressOptions.onCancel) {
        await this.expressOptions.onCancel();
      }

      // If Checkout provides updated amount after cancel (via onAmountUpdated),
      // we would update it here, but typically cancel means reverting to original amount
      // which Checkout should handle via onCancel callback
    } catch (error) {
      this.baseOptions.onError?.(new Error('Error handling Express Checkout cancel.'));
    }
  }

  /**
   * Handles the payment confirmation flow when user authorizes payment in Express Checkout.
   * This is triggered by the "confirm" event from StripeExpressCheckoutElement.
   */
  private async handlePaymentConfirm(): Promise<void> {
    try {
      // Step 1: Validate elements (paymentMethod already authorized is in elements)
      const { error: submitError } = await this.baseOptions.elements.submit();

      if (submitError) {
        throw submitError;
      }

      // Step 2: Get shipping and billing addresses
      // Note: Stripe handles addresses internally in elements, but we need them for onPaymentSubmit
      // We'll try to get them from the element, but if not available, Checkout should have them
      // from the cart after onShippingAddressSelected was called
      let shippingAddress: any = null;
      let billingAddress: any = null;

      // Try to get addresses from Stripe element (may not always be available)
      try {
        shippingAddress = this.getShippingAddressFromStripe();
        billingAddress = this.getBillingAddressFromStripe();
      } catch {
        // If addresses are not available from element, Checkout should provide them from the cart
      }

      // Step 3: Call onPaymentSubmit callback (required by template)
      await this.expressOptions.onPaymentSubmit({
        shippingAddress: shippingAddress 
          ? this.convertToExpressAddress(shippingAddress)
          : ({} as ExpressAddressData),
        billingAddress: billingAddress
          ? this.convertToExpressAddress(billingAddress)
          : ({} as ExpressAddressData),
      });

      // Step 4: Create PaymentIntent in processor (same endpoint as drop-in normal)
      // Use currentSessionId (from onPayButtonClick) instead of baseOptions.sessionId
      const paymentRes = await this.getPayment();

      // Step 5: Confirm PaymentIntent with Stripe using elements (paymentMethod comes from elements)
      const { paymentIntent } = await this.confirmStripePayment({
        merchantReturnUrl: paymentRes.merchantReturnUrl,
        cartId: paymentRes.cartId,
        clientSecret: paymentRes.sClientSecret,
        paymentReference: paymentRes.paymentReference,
        ...(billingAddress && {
          billingAddress: this.convertStripeAddressToBillingAddress(billingAddress),
        }),
      });

      // Step 6: Confirm in commercetools
      await this.confirmPaymentIntent({
        paymentIntentId: paymentIntent.id,
        paymentReference: paymentRes.paymentReference,
      });

      // Step 7: Notify success
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
   * Creates PaymentIntent in the processor.
   * Uses the same endpoint as drop-in normal flow.
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
   * Confirms PaymentIntent with Stripe.
   * Uses elements (which contains the authorized paymentMethod) instead of passing paymentMethod manually.
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
   * Confirms PaymentIntent in commercetools.
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
   * Gets headers configuration for API requests.
   * Uses currentSessionId (from onPayButtonClick) instead of baseOptions.sessionId.
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

  private convertToExpressAddress(stripeAddress: any): ExpressAddressData {
    // Support both nested (address: { country, city, ... }) and flat ({ country, city, ... }) shapes from Stripe
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
