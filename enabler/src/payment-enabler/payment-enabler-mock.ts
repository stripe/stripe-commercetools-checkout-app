import {
  DropinType, EnablerOptions,
  PaymentComponentBuilder,
  PaymentDropinBuilder,
  PaymentEnabler, PaymentResult,
} from "./payment-enabler";
import { DropinEmbeddedBuilder } from "../dropin/dropin-embedded";
import {
  Appearance,
  LayoutObject,
  loadStripe,
  Stripe,
  StripeElements,
  StripePaymentElementOptions
} from "@stripe/stripe-js";
import { StripePaymentElement } from "@stripe/stripe-js";
import {
  ConfigElementResponseSchemaDTO,
  ConfigResponseSchemaDTO,
  CustomerResponseSchemaDTO
} from "../dtos/mock-payment.dto.ts";
import { parseJSON } from "../utils";

declare global {
  interface ImportMeta {
    // @ts-ignore
    env: any;
  }
}

export type BaseOptions = {
  sdk: Stripe;
  environment: string;
  processorUrl: string;
  sessionId: string;
  locale?: string;
  onComplete: (result: PaymentResult) => void;
  onError: (error?: any) => void;
  paymentElement: StripePaymentElement; // MVP https://docs.stripe.com/payments/payment-element
  elements: StripeElements; // MVP https://docs.stripe.com/js/elements_object
  stripeCustomerId?: string;
};

interface ElementsOptions {
  type: string;
  options: Record<string, any>;
  onComplete: (result: PaymentResult) => void;
  onError: (error?: any) => void;
  layout: LayoutObject;
  appearance: Appearance;
  fields: {
    billingDetails: {
      address: string;
    };
  };
}

export class MockPaymentEnabler implements PaymentEnabler {
  setupData: Promise<{ baseOptions: BaseOptions }>;

  constructor(options: EnablerOptions) {
    this.setupData = MockPaymentEnabler._Setup(options);
  }

  private static _Setup = async (
    options: EnablerOptions
  ): Promise<{ baseOptions: BaseOptions }> => {
    const paymentMethodType : string = 'payment'
    const [cartInfoResponse, configEnvResponse] = await MockPaymentEnabler.fetchConfigData(paymentMethodType, options);
    const stripeSDK = await MockPaymentEnabler.getStripeSDK(configEnvResponse);
    const customer = await MockPaymentEnabler.getCustomerOptions(options);
    const elements = MockPaymentEnabler.getElements(stripeSDK, cartInfoResponse, customer);
    const elementsOptions = MockPaymentEnabler.getElementsOptions(options, cartInfoResponse);

    return Promise.resolve({
      baseOptions: {
        sdk: stripeSDK,
        environment: configEnvResponse.publishableKey.includes("_test_") ? "test" : configEnvResponse.environment, // MVP do we get this from the env of processor? or we leave the responsability to the publishableKey from Stripe?
        processorUrl: options.processorUrl,
        sessionId: options.sessionId,
        onComplete: options.onComplete || (() => {}),
        onError: options.onError || (() => {}),
        paymentElement: elements.create('payment', elementsOptions as StripePaymentElementOptions ),// MVP this could be expressCheckout or payment for subscritpion.
        elements: elements,
        ...(customer && {stripeCustomerId: customer?.stripeCustomerId,})
      },
    });
  };

  async createComponentBuilder(
    type: string
  ): Promise<PaymentComponentBuilder | never> {
    const { baseOptions } = await this.setupData;
    const supportedMethods = {};

    if (!Object.keys(supportedMethods).includes(type)) {
      throw new Error(
        `Component type not supported: ${type}. Supported types: ${Object.keys(
          supportedMethods
        ).join(", ")}`
      );
    }

    return new supportedMethods[type](baseOptions);
  }

  async createDropinBuilder(
    type: DropinType
  ): Promise<PaymentDropinBuilder | never> {

    const setupData = await this.setupData;
    if (!setupData) {
      throw new Error("StripePaymentEnabler not initialized");
    }
    const supportedMethods = {
      embedded: DropinEmbeddedBuilder,
      // hpp: DropinHppBuilder,
    };

    if (!Object.keys(supportedMethods).includes(type)) {
      throw new Error(
        `Component type not supported: ${type}. Supported types: ${Object.keys(
          supportedMethods
        ).join(", ")}`
      );
    }
    return new supportedMethods[type](setupData.baseOptions);
  }

  private static async getStripeSDK(configEnvResponse: ConfigResponseSchemaDTO): Promise<Stripe | null> {
    try {
      const sdk = await loadStripe(configEnvResponse.publishableKey);
      if (!sdk) throw new Error("Failed to load Stripe SDK.");
      return sdk;
    } catch (error) {
      console.error("Error loading Stripe SDK:", error);
      throw error; // or handle based on your requirements
    }
  }

  private static getElements(
    stripeSDK: Stripe | null,
    cartInfoResponse: ConfigElementResponseSchemaDTO,
    customer: CustomerResponseSchemaDTO
  ): StripeElements | null {
    if (!stripeSDK) return null;
    try {
      return stripeSDK.elements?.({
        mode: 'payment',
        amount: cartInfoResponse.cartInfo.amount,
        currency: cartInfoResponse.cartInfo.currency.toLowerCase(),
        ...(customer && {
          customerOptions: {
            customer: customer.stripeCustomerId,
            ephemeralKey: customer.ephemeralKey,
          },
          setupFutureUsage: cartInfoResponse.setupFutureUsage,
          customerSessionClientSecret: customer.sessionId,
        }),
        appearance: parseJSON(cartInfoResponse.appearance),
        capture_method: cartInfoResponse.captureMethod,
      });
    } catch (error) {
      console.error("Error initializing elements:", error);
      return null;
    }
  }

  private static async fetchConfigData(
    paymentMethodType: string, options: EnablerOptions
  ): Promise<[ConfigElementResponseSchemaDTO, ConfigResponseSchemaDTO]> {
    const headers = MockPaymentEnabler.getFetchHeader(options);

    const [configElementResponse, configEnvResponse] = await Promise.all([
      fetch(`${options.processorUrl}/config-element/${paymentMethodType}`, headers), // MVP this could be used by expressCheckout and Subscription
      fetch(`${options.processorUrl}/operations/config`, headers),
    ]);

    return Promise.all([configElementResponse.json(), configEnvResponse.json()]);
  }

  private static getFetchHeader(options: EnablerOptions): { method: string, headers: { [key: string]: string }} {
    return {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        "X-Session-Id": options.sessionId,
      },
    }
  }

  private static getElementsOptions(
    options: EnablerOptions,
    config: ConfigElementResponseSchemaDTO
  ): ElementsOptions {
    const { appearance, layout, collectBillingAddress } = config;
    return {
      type: 'payment',
      options: {},
      onComplete: options.onComplete,
      onError: options.onError,
      layout: this.getLayoutObject(layout),
      appearance: parseJSON(appearance),
      ...(collectBillingAddress !== 'auto' && {
        fields: {
          billingDetails: {
            address: collectBillingAddress,
          }
        }
      }),
    }
  }

  private static async getCustomerOptions(options: EnablerOptions): Promise<CustomerResponseSchemaDTO> {
    const headers = MockPaymentEnabler.getFetchHeader(options);
    const apiUrl = new URL(`${options.processorUrl}/customer/session`);
    const response = await fetch(apiUrl.toString(), headers);

    if (response.status === 204) {
      console.log("No Stripe customer session");
      return undefined;
    }
    const data: CustomerResponseSchemaDTO = await response.json();
    return data;
  }

  private static getLayoutObject(layout: string): LayoutObject {
    if (layout) {
      const parsedObject = parseJSON<LayoutObject>(layout);
      const isValid = this.validateLayoutObject(parsedObject);
      if (isValid) {
        return parsedObject;
      }
    }

    return {
      type: 'tabs',
      defaultCollapsed: false,
    };
  }

  private static validateLayoutObject(layout: LayoutObject): boolean {
    if (!layout) return false;
    const validLayouts = ['tabs', 'accordion', 'auto'];
    return validLayouts.includes(layout.type);
  }
}
