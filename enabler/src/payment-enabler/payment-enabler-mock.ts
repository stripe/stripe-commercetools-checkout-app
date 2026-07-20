import {
  DropinType, EnablerOptions,
  PaymentComponentBuilder,
  PaymentDropinBuilder,
  PaymentEnabler, PaymentResult,
  PaymentExpressBuilder,
} from "./payment-enabler";
import { DropinEmbeddedBuilder } from "../dropin/dropin-embedded";
import { StripeExpressBuilder } from "../express/dropin-express";
import {
  Appearance,
  LayoutObject,
  loadStripe,
  Stripe,
  StripeElements,
  StripePaymentElementOptions
} from "@stripe/stripe-js";
import type { StripeElementLocale, StripeExpressCheckoutElementOptions } from "@stripe/stripe-js";
import { convertToStripeLocale } from "../converters/locale.converter";

export type ExpressElementOptions = Pick<
  StripeExpressCheckoutElementOptions,
  'buttonHeight' | 'buttonTheme' | 'buttonType' | 'emailRequired' | 'layout' | 'paymentMethodOrder' | 'phoneNumberRequired'
>;

const ALLOWED_EXPRESS_OPTION_KEYS: ReadonlyArray<keyof ExpressElementOptions> = [
  'buttonHeight', 'buttonTheme', 'buttonType', 'emailRequired', 'layout', 'paymentMethodOrder', 'phoneNumberRequired',
];

/**
 * Shape of STRIPE_BEHAVIOR_PAYMENT_ELEMENT ("Elements Behavior" in Merchant Center), already
 * parsed and schema-validated by the processor — the enabler only merges it with the legacy
 * layout/collectBillingAddress env vars, it does not re-validate.
 */
export type PaymentElementBehaviorOptions = Pick<
  StripePaymentElementOptions,
  'terms' | 'wallets' | 'defaultValues' | 'business' | 'paymentMethodOrder' | 'readOnly' | 'layout' | 'fields'
>;
import { StripePaymentElement } from "@stripe/stripe-js";
import {
  ConfigElementResponseSchemaDTO,
  ConfigResponseSchemaDTO,
  CustomerResponseSchemaDTO,
  PaymentResponseSchemaDTO,
} from "../dtos/mock-payment.dto";
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
  locale?: StripeElementLocale;
  onComplete: (result: PaymentResult) => void;
  onError: (error?: any) => void;
  paymentElement: StripePaymentElement; // MVP https://docs.stripe.com/payments/payment-element
  elements: StripeElements | null; // MVP https://docs.stripe.com/js/elements_object — null when Express without session (deferred to init)
  stripeCustomerId?: string;
  expressCheckout?: boolean; // When true, processor omits shipping on PaymentIntent (Express only).
  captureMethod?: string; // Stored by _SetupExpress for deferred elements creation in init()
  appearance?: any; // Stored by _SetupExpress for deferred elements creation in init()
  expressElementOptions?: ExpressElementOptions; // Stored by _SetupExpress for ExpressCheckoutElement creation in init()
  flowType?: 'deferred' | 'pi_first';
  /**
   * Full PI response cached by _Setup() when flowType === 'pi_first'.
   * Contains: sClientSecret, paymentReference, merchantReturnUrl, cartId, billingAddress.
   * submit() reads from this cache. getPayment() is NEVER called in pi_first mode.
   */
  piFirstResponse?: PaymentResponseSchemaDTO;
};

interface ElementsOptions {
  type: string;
  options: Record<string, any>;
  onComplete: (result: PaymentResult) => void;
  onError: (error?: any) => void;
  layout: LayoutObject | StripePaymentElementOptions['layout'];
  appearance: Appearance;
  fields?: StripePaymentElementOptions['fields'];
  terms?: StripePaymentElementOptions['terms'];
  wallets?: StripePaymentElementOptions['wallets'];
  defaultValues?: StripePaymentElementOptions['defaultValues'];
  business?: StripePaymentElementOptions['business'];
  paymentMethodOrder?: StripePaymentElementOptions['paymentMethodOrder'];
  readOnly?: StripePaymentElementOptions['readOnly'];
}

export class MockPaymentEnabler implements PaymentEnabler {
  private sessionFlowSetupData: Promise<{ baseOptions: BaseOptions }> | null = null;
  private expressSetupData: Promise<{ baseOptions: BaseOptions }> | null = null;
  private expressSessionFlowSetupData: Promise<{ baseOptions: BaseOptions }> | null = null;
  private options: EnablerOptions;

  constructor(options: EnablerOptions) {
    this.options = options;
  }

  /**
   * Session flow init: runs _Setup on first use (dropin/component). Cached per enabler instance.
   */
  private getSessionFlowBaseOptions(): Promise<{ baseOptions: BaseOptions }> {
    if (!this.sessionFlowSetupData) {
      this.sessionFlowSetupData = MockPaymentEnabler._Setup(this.options);
    }
    return this.sessionFlowSetupData;
  }

  /**
   * Express init without session: uses POST /express-config (CORS only). Cached per enabler instance.
   */
  private getExpressBaseOptions(): Promise<{ baseOptions: BaseOptions }> {
    if (!this.expressSetupData) {
      this.expressSetupData = MockPaymentEnabler._SetupExpress(this.options);
    }
    return this.expressSetupData;
  }

  /**
   * Express init with session: always runs _Setup with skipPiFirst=true.
   * Express Checkout elements require { mode, amount, currency } initialization — clientSecret-based
   * elements (pi_first) are incompatible with elements.update({ amount, currency }) called in init().
   */
  private getExpressSessionFlowBaseOptions(): Promise<{ baseOptions: BaseOptions }> {
    if (!this.expressSessionFlowSetupData) {
      this.expressSessionFlowSetupData = MockPaymentEnabler._Setup(this.options, { skipPiFirst: true });
    }
    return this.expressSessionFlowSetupData;
  }

  private static _Setup = async (
    options: EnablerOptions,
    { skipPiFirst = false } = {},
  ): Promise<{ baseOptions: BaseOptions }> => {
    const paymentMethodType : string = 'payment'
    const [cartInfoResponse, configEnvResponse] = await MockPaymentEnabler.fetchConfigData(paymentMethodType, options);
    const stripeSDK = await MockPaymentEnabler.getStripeSDK(configEnvResponse);
    const customer = await MockPaymentEnabler.getCustomerOptions(options);
    const locale = convertToStripeLocale(options.locale);

    // pi_first: fetch the PaymentIntent eagerly so we have a clientSecret to pass to
    // stripe.elements({ clientSecret }). This pre-binds the PI before rendering, which
    // is required for payment methods like Blik that cannot use the deferred intent flow.
    //
    // IMPORTANT: GET /payments uses crypto.randomUUID() as idempotency key — it always
    // creates a new PI. This call must happen exactly once per component mount. The full
    // response is cached in baseOptions.piFirstResponse; submit() reads from the cache
    // and never calls getPayment().
    let piFirstResponse: PaymentResponseSchemaDTO | undefined;
    if (cartInfoResponse.flowType === 'pi_first' && !skipPiFirst) {
      piFirstResponse = await MockPaymentEnabler.fetchPayment(options);
    }

    const elements = MockPaymentEnabler.getElements(
      stripeSDK,
      cartInfoResponse,
      customer,
      locale,
      piFirstResponse?.sClientSecret,
    );
    const elementsOptions = MockPaymentEnabler.getElementsOptions(options, cartInfoResponse);

    return Promise.resolve({
      baseOptions: {
        sdk: stripeSDK,
        environment: configEnvResponse.publishableKey.includes("_test_") ? "test" : configEnvResponse.environment, // MVP do we get this from the env of processor? or we leave the responsability to the publishableKey from Stripe?
        processorUrl: options.processorUrl,
        sessionId: options.sessionId,
        locale,
        onComplete: options.onComplete || (() => {}),
        onError: options.onError || (() => {}),
        paymentElement: elements.create('payment', elementsOptions as StripePaymentElementOptions ),// MVP this could be expressCheckout or payment for subscritpion.
        elements: elements,
        ...(customer && {stripeCustomerId: customer?.stripeCustomerId,}),
        ...(configEnvResponse.expressElementOptions && (() => {
          const raw = parseJSON<Record<string, unknown>>(configEnvResponse.expressElementOptions!);
          const expressElementOptions = Object.fromEntries(
            ALLOWED_EXPRESS_OPTION_KEYS.filter((k) => raw[k] !== undefined).map((k) => [k, raw[k]]),
          ) as ExpressElementOptions;
          return { expressElementOptions };
        })()),
        ...(cartInfoResponse.flowType && { flowType: cartInfoResponse.flowType }),
        ...(piFirstResponse && { piFirstResponse }),
      },
    });
  };

  async createComponentBuilder(
    type: string
  ): Promise<PaymentComponentBuilder | never> {
    const { baseOptions } = await this.getSessionFlowBaseOptions();
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
    const setupData = await this.getSessionFlowBaseOptions();
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

  async createExpressBuilder(
    type: string
  ): Promise<PaymentExpressBuilder | never> {
    const { baseOptions } = this.options.sessionId
      ? await this.getExpressSessionFlowBaseOptions()
      : await this.getExpressBaseOptions();
    const supportedMethods: Record<string, typeof StripeExpressBuilder> = {
      dropin: StripeExpressBuilder,
    };

    if (!Object.keys(supportedMethods).includes(type)) {
      throw new Error(
        `Express checkout type not supported: ${type}. Supported types: ${Object.keys(
          supportedMethods
        ).join(", ")}`
      );
    }

    return new supportedMethods[type]({ ...baseOptions, expressCheckout: true });
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
    customer: CustomerResponseSchemaDTO,
    locale?: StripeElementLocale,
    piClientSecret?: string,
  ): StripeElements | null {
    if (!stripeSDK) return null;
    try {
      if (piClientSecret) {
        // pi_first mode: bind elements to the existing PaymentIntent.
        // customerOptions and setupFutureUsage are intentionally omitted — they are
        // incompatible with clientSecret-based initialization and are set on the PI directly.
        return stripeSDK.elements?.({
          clientSecret: piClientSecret,
          appearance: parseJSON(cartInfoResponse.appearance),
          ...(locale && { locale }),
        });
      }
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
        ...(locale && { locale }),
      });
    } catch (error) {
      console.error("Error initializing elements:", error);
      return null;
    }
  }

  /**
   * Fetches Express config from POST /express-config (no session). Used when rendering Express buttons without session.
   * Does NOT create a Stripe Elements instance — that is deferred to StripeExpressComponent.init() where
   * the real initialAmount (currency + centAmount) from ExpressOptions is available.
   */
  private static _SetupExpress = async (
    options: EnablerOptions
  ): Promise<{ baseOptions: BaseOptions }> => {
    const res = await fetch(`${options.processorUrl}/express-config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    if (!res.ok) {
      if (res.status === 403) {
        throw new Error('Unauthorized error fetching express config');
      }
      throw new Error('Not able to initialize Express Checkout');
    }
    const configEnvResponse: ConfigResponseSchemaDTO = await res.json();
    const stripeSDK = await MockPaymentEnabler.getStripeSDK(configEnvResponse);
    if (!stripeSDK) throw new Error('Failed to load Stripe SDK for Express.');
    const environment = configEnvResponse.publishableKey.includes('_test_')
      ? 'test'
      : configEnvResponse.environment;
    const locale = convertToStripeLocale(options.locale);
    return {
      baseOptions: {
        sdk: stripeSDK,
        environment,
        processorUrl: options.processorUrl,
        sessionId: options.sessionId,
        locale,
        onComplete: options.onComplete || (() => {}),
        onError: options.onError || (() => {}),
        paymentElement: null as unknown as StripePaymentElement,
        elements: null,
        expressCheckout: true,
        captureMethod: configEnvResponse.captureMethod ?? 'automatic',
        ...(configEnvResponse.appearance && { appearance: parseJSON(configEnvResponse.appearance) }),
        ...(configEnvResponse.expressElementOptions && (() => {
          const raw = parseJSON<Record<string, unknown>>(configEnvResponse.expressElementOptions!);
          const expressElementOptions = Object.fromEntries(
            ALLOWED_EXPRESS_OPTION_KEYS.filter((k) => raw[k] !== undefined).map((k) => [k, raw[k]]),
          ) as ExpressElementOptions;
          return { expressElementOptions };
        })()),
      },
    };
  };

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

  private static async fetchPayment(options: EnablerOptions): Promise<PaymentResponseSchemaDTO> {
    const headers = MockPaymentEnabler.getFetchHeader(options);
    const response = await fetch(`${options.processorUrl}/payments`, headers);

    if (!response.ok) {
      throw new Error(`Failed to initialize pi_first payment: ${response.status}`);
    }

    const data = await response.json();

    if (!data.sClientSecret || !data.paymentReference) {
      throw new Error('Invalid payment response from processor: missing required fields');
    }

    return data as PaymentResponseSchemaDTO;
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

  /**
   * Merges STRIPE_BEHAVIOR_PAYMENT_ELEMENT ("Elements Behavior") with the legacy layout/
   * collectBillingAddress env vars, per-attribute: a Field 2 value wins if explicitly present,
   * otherwise the legacy env var (or connector default) applies. `terms`, `wallets`,
   * `defaultValues`, `business`, `paymentMethodOrder`, `readOnly` have no legacy equivalent and
   * pass straight through when present.
   */
  private static getElementsOptions(
    options: EnablerOptions,
    config: ConfigElementResponseSchemaDTO
  ): ElementsOptions {
    const { appearance, layout, collectBillingAddress, paymentElementOptions } = config;
    const behaviorOptions = parseJSON<PaymentElementBehaviorOptions>(paymentElementOptions);

    const resolvedLayout = behaviorOptions.layout ?? this.getLayoutObject(layout);
    const resolvedFields =
      behaviorOptions.fields ??
      (collectBillingAddress !== 'auto' ? { billingDetails: { address: collectBillingAddress } } : undefined);

    return {
      type: 'payment',
      options: {},
      onComplete: options.onComplete,
      onError: options.onError,
      layout: resolvedLayout,
      appearance: parseJSON(appearance),
      ...(resolvedFields && { fields: resolvedFields }),
      ...(behaviorOptions.terms && { terms: behaviorOptions.terms }),
      ...(behaviorOptions.wallets && { wallets: behaviorOptions.wallets }),
      ...(behaviorOptions.defaultValues && { defaultValues: behaviorOptions.defaultValues }),
      ...(behaviorOptions.business && { business: behaviorOptions.business }),
      ...(behaviorOptions.paymentMethodOrder && { paymentMethodOrder: behaviorOptions.paymentMethodOrder }),
      ...(behaviorOptions.readOnly !== undefined && { readOnly: behaviorOptions.readOnly }),
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
