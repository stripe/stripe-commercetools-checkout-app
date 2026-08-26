
import { PaymentResponseSchemaDTO } from "../dtos/mock-payment.dto";
import {
  DropinComponent,
  DropinOptions,
  PaymentDropinBuilder,
} from "../payment-enabler/payment-enabler";
import { BaseOptions } from "../payment-enabler/payment-enabler-mock";
import { StripePaymentElement} from "@stripe/stripe-js";
import { isBankTransferNextAction } from "../utils";

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
  }
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

export class DropinEmbeddedBuilder implements PaymentDropinBuilder {
  public dropinHasSubmit = true;
  private baseOptions: BaseOptions;

  constructor(baseOptions: BaseOptions) {
    this.baseOptions = baseOptions;
  }

  build(config: DropinOptions): DropinComponent {
    const dropin = new DropinComponents({
      baseOptions: this.baseOptions,
      dropinOptions: config,
    });

    dropin.init();
    return dropin;
  }
}

export class DropinComponents implements DropinComponent {
  private baseOptions: BaseOptions;
  private paymentElement: StripePaymentElement;
  private dropinOptions: DropinOptions;

  constructor(opts: {
    baseOptions: BaseOptions,
    dropinOptions: DropinOptions
  }) {
    this.baseOptions = opts.baseOptions;
    this.dropinOptions = opts.dropinOptions;
  }

  init(): void {
    this.dropinOptions.showPayButton = false;
    this.paymentElement = this.baseOptions.paymentElement;
  }

  async mount(selector: string) {
    if (this.baseOptions.paymentElement) {
      this.paymentElement.mount(selector);
    } else {
      console.error("Payment Element not initialized");
    }
  }

  async submit(): Promise<void> {
    try {
      const { error: submitError } = await this.baseOptions.elements!.submit();

      if (submitError) {
        throw submitError;
      }

      let sClientSecret: string;
      let paymentReference: string;
      let merchantReturnUrl: string;
      let cartId: string;
      let billingAddress: string | undefined;

      if (this.baseOptions.flowType === 'pi_first') {
        // pi_first: use the full response cached by _Setup(). getPayment() is NEVER called
        // here — doing so would create a second PaymentIntent (orphan PI risk).
        if (!this.baseOptions.piFirstResponse) {
          throw new Error('pi_first: missing cached PaymentIntent response in baseOptions. _Setup() must populate piFirstResponse before submit() is called.');
        }
        ({ sClientSecret, paymentReference, merchantReturnUrl, cartId, billingAddress } =
          this.baseOptions.piFirstResponse);
      } else {
        // deferred: existing flow unchanged
        ({ sClientSecret, paymentReference, merchantReturnUrl, cartId, billingAddress } =
          await this.getPayment());
      }

      const { paymentIntent } = await this.confirmStripePayment({
        merchantReturnUrl,
        cartId,
        clientSecret: sClientSecret,
        paymentReference,
        ...(billingAddress && {billingAddress: JSON.parse(billingAddress) as BillingAddress}),
      });

      await this.confirmPaymentIntent({
        paymentIntentId: paymentIntent.id,
        paymentReference,
      });
    } catch(error) {
      this.baseOptions.onError?.(error);
    }
  }

  private async getPayment(): Promise<PaymentResponseSchemaDTO> {
    const apiUrl = new URL(`${this.baseOptions.processorUrl}/payments`);
    const response = await fetch(apiUrl.toString(), {
      method: "GET",
      headers: this.getHeadersConfig(),
    });

    if (!response.ok) {
      const error = await response.json();
      console.warn(`Error in processor getting Payment: ${error.message}`);
      throw error;
    } else {
      return await response.json();
    }
  }

  private async confirmStripePayment({
    merchantReturnUrl,
    cartId,
    clientSecret,
    paymentReference,
    billingAddress,
  }: ConfirmPaymentProps) {
    const returnUrl = new URL(merchantReturnUrl);
    returnUrl.searchParams.append("cartId", cartId);
    returnUrl.searchParams.append("paymentReference", paymentReference);

    const { error, paymentIntent } = await this.baseOptions.sdk.confirmPayment({
      elements: this.baseOptions.elements!,
      clientSecret,
      confirmParams: {
        return_url: returnUrl.toString(),
        ...(billingAddress &&{
          payment_method_data: {
            billing_details: billingAddress
          }
        })
      },
      redirect: "if_required",
    });

    if (error) {
      // A buyer who closed the bank transfer instructions has NOT failed, and Stripe.js reports
      // that dismissal HERE — as an error — not as a resolved PaymentIntent. Measured 2026-08-17
      // against the commercetools overlay: the guard further down never ran, because this throw
      // fires first, and the buyer landed on "Payment Failed" while the PaymentIntent was alive
      // and awaiting a wire.
      //
      // The PaymentIntent is re-read rather than taken from `error.payment_intent`, which Stripe
      // populates inconsistently: the client secret is already in scope and retrieve is
      // authoritative, so this does not depend on the error's shape.
      //
      // Only an awaiting-bank-transfer intent is rescued. A genuine decline leaves the intent in
      // requires_payment_method, and every other next_action variant fails the predicate, so both
      // keep throwing exactly as before.
      const rescued = await this.retrieveAwaitingBankTransfer(clientSecret);
      if (rescued) {
        return { paymentIntent: rescued };
      }
      throw error;
    }

    // A bank transfer awaiting funds is NOT an error, and this is the branch that decides it.
    //
    // Stripe.js has already shown the buyer its own instructions modal (measured 2026-08-13 inside
    // the commercetools overlay), and they have closed it to go to their bank. From the buyer's side
    // everything that can happen inside checkout has happened; the money is days away. Throwing here
    // surfaced as `payment_failed` on the host and put them on a "Payment Failed" screen — after
    // which nobody wires anything. Instead we fall through to confirmPaymentIntent(), where the
    // processor answers 202/`pending` and onComplete({ isSuccess: false }) reports a non-success
    // without claiming a failure.
    //
    // EVERY OTHER `requires_action` STILL THROWS, and that is required rather than incidental: card
    // 3DS, Boleto and redirect-based methods reach here having completed nothing, so the host must
    // treat them as errors exactly as before. The predicate is the only thing separating the two,
    // which is why it checks the next_action type strictly and fails closed.
    if (paymentIntent.status === "requires_action" && !isBankTransferNextAction(paymentIntent)) {
      const error: any = new Error("Payment requires additional action");
      error.type = "requires_action";
      error.next_action = paymentIntent.next_action;
      throw error;
    }
    if(paymentIntent.last_payment_error) {
      const error: any = new Error(`${paymentIntent.last_payment_error.message}`);
      error.type = "payment_failed";
      error.last_payment_error = paymentIntent.last_payment_error;
      throw error;
    } 

    return { paymentIntent };
  }

  /**
   * Returns the PaymentIntent when it is a bank transfer awaiting funds, otherwise undefined.
   *
   * Used from the error path of confirmPayment. Never throws: if the retrieve itself fails there is
   * nothing to rescue, and the caller must be free to re-throw the ORIGINAL error rather than a
   * diagnostic one about the rescue attempt.
   */
  private async retrieveAwaitingBankTransfer(
    clientSecret: string,
  ): Promise<Awaited<ReturnType<typeof this.baseOptions.sdk.retrievePaymentIntent>>['paymentIntent'] | undefined> {
    try {
      const { paymentIntent } = await this.baseOptions.sdk.retrievePaymentIntent(clientSecret);
      if (paymentIntent?.status === "requires_action" && isBankTransferNextAction(paymentIntent)) {
        return paymentIntent;
      }
    } catch {
      // fall through — the original error is the one worth surfacing
    }
    return undefined;
  }

  private async confirmPaymentIntent({
    paymentIntentId,
    paymentReference,
  }: ConfirmPaymentIntentProps) {
    const apiUrl = `${this.baseOptions.processorUrl}/confirmPayments/${paymentReference}`;
    const response = await fetch(apiUrl, {
      method: "POST",
      headers: this.getHeadersConfig(),
      body: JSON.stringify({ paymentIntent: paymentIntentId }),
    });

    if (!response.ok) {
      throw "Error on /confirmPayments";
    }

    const { outcome } = (await response.json()) as { outcome?: string };

    // Async settlement (e.g. crypto/stablecoin): the processor returns 202 with outcome
    // "pending" — the PaymentIntent is still processing. Do NOT signal success here, or the
    // merchant would fulfill the order prematurely. The order is created by the webhook on
    // payment_intent.succeeded. Surface a non-success (processing) result instead.
    if (outcome === "pending") {
      this.baseOptions.onComplete?.({ isSuccess: false });
      return;
    }

    this.baseOptions.onComplete?.({ isSuccess: true, paymentReference });
  }

  private getHeadersConfig(): HeadersInit {
    return {
      "Content-Type": "application/json",
      "x-session-id": this.baseOptions.sessionId,
    };
  }
}

