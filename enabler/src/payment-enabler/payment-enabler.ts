/**
 * Represents the payment enabler. The payment enabler is the entry point for creating the components.
 *
 * Usage:
 *    const enabler = new Enabler({
 *      processorUrl: __VITE_PROCESSOR_URL__,
 *      sessionId: sessionId,
 *      config: {
 *
 *      },
 *      onComplete: ({ isSuccess, paymentReference }) => {
 *        console.log('onComplete', { isSuccess, paymentReference });
 *      },
 *    });
 *
 *    enabler.createComponentBuilder('card')
 *      .then(builder => {
 *          const paymentElement = builder.build({
 *            showPayButton: false,
 *          });
 *          paymentElement.mount('#card-component')
 *      })
 *
 *    enabler.createComponentBuilder('invoice')
 *      .then(builder => {
 *          const paymentElement = builder.build({});
 *          paymentElement.mount('#invoice-component')
 *      })
 */
export interface PaymentEnabler {
  /**
   * Creates a payment component builder of the specified type.
   * @param type - The type of the payment component builder.
   * @returns A promise that resolves to the payment component builder.
   * @throws {Error} If the payment component builder cannot be created.
   */
  createComponentBuilder: (
    type: string
  ) => Promise<PaymentComponentBuilder | never>;

  /**
   * Creates a payment drop-in builder of the specified type.
   * @param type - The type of the payment drop-in builder.
   * @returns A promise that resolves to the payment drop-in builder.
   * @throws {Error} If the payment drop-in builder cannot be created.
   */
  createDropinBuilder: (
    type: DropinType
  ) => Promise<PaymentDropinBuilder | never>;

  /**
   * Creates an express checkout builder of the specified type.
   * @param type - The type of the express checkout builder.
   * @returns A promise that resolves to the express checkout builder.
   * @throws {Error} If the express checkout builder cannot be created.
   */
  createExpressBuilder: (
    type: string
  ) => Promise<PaymentExpressBuilder | never>;
}

/**
 * Represents the interface for a payment component.
 */
export interface PaymentComponent {
  /**
   * Mounts the payment component to the specified selector.
   * @param selector - The selector where the component will be mounted.
   */
  mount(selector: string): void;

  /**
   * Submits the payment.
   */
  submit(): void;

  /**
   * Shows the validation for the payment component.
   */
  showValidation?(): void;

  /**
   * Checks if the payment component is valid.
   * @returns A boolean indicating whether the payment component is valid.
   */
  isValid?(): boolean;

  /**
   * Gets the state of the payment component.
   * @returns An object representing the state of the payment component.
   */
  getState?(): {
    card?: {
      endDigits?: string;
      brand?: string;
      expiryDate?: string;
    };
  };

  /**
   * Checks if the payment component is available for use.
   * @returns A promise that resolves to a boolean indicating whether the payment component is available.
   */
  isAvailable?(): Promise<boolean>;
}

/**
 * Represents the interface for a payment component builder.
 */
export interface PaymentComponentBuilder {
  /**
   * Indicates whether the component has a submit action.
   */
  componentHasSubmit?: boolean;

  /**
   * Builds a payment component with the specified configuration.
   * @param config - The configuration options for the payment component.
   * @returns The built payment component.
   */
  build(config: ComponentOptions): PaymentComponent;
}

/**
 * Represents the options for the payment enabler.
 */
export type EnablerOptions = {
  /**
   * The URL of the payment processor.
   */
  processorUrl: string;

  /**
   * The session ID for the payment.
   */
  sessionId: string;

  /**
   * The locale for the payment.
   */
  locale?: string;

  /**
   * A callback function that is called when an action is required during the payment process.
   * @returns A promise that resolves when the action is completed.
   */
  onActionRequired?: () => Promise<void>;

  /**
   * A callback function that is called when the payment is completed.
   * @param result - The result of the payment.
   */
  onComplete?: (result: PaymentResult) => void;

  /**
   * A callback function that is called when an error occurs during the payment process.
   * @param error - The error that occurred.
   */
  onError?: (error: any) => void;
};

/**
 * Represents the payment method code.
 */
export enum PaymentMethod {
  /* Apple Pay */
  applepay = "applepay",
  /* Bancontact card */
  bancontactcard = "bcmc",
  /* Card */
  card = "card",
  /* EPS */
  eps = "eps",
  /* Google Pay */
  googlepay = "googlepay",
  /* iDeal */
  ideal = "ideal",
  /* iDeal */
  invoice = "invoice",
  /* Klarna Pay Later */
  klarna_pay_later = "klarna",
  /* Klarna Pay Now */
  klarna_pay_now = "klarna_paynow",
  /* Klarna Pay Over Time */
  klarna_pay_overtime = "klarna_account",
  /* PayPal */
  paypal = "paypal",
  /* Purchase Order */
  purchaseorder = "purchaseorder",
  /* TWINT */
  twint = "twint",
  dropin = "dropin",
}

/**
 * Represents the result of a payment.
 */
export type PaymentResult =
  | {
      /**
       * Indicates whether the payment was successful.
       */
      isSuccess: true;

      /**
       * The payment reference.
       */
      paymentReference: string;
    }
  | {
      /**
       * Indicates whether the payment was unsuccessful.
       */
      isSuccess: false;
    };

/**
 * Represents the options for a payment component.
 */
export type ComponentOptions = {
  /**
   * Indicates whether to show the pay button.
   */
  showPayButton?: boolean;

  /**
   * A callback function that is called when the pay button is clicked.
   * @returns A Promise indicating whether the payment should proceed.
   */
  onPayButtonClick?: () => Promise<void>;
};

/**
 * Represents the payment drop-in types.
 */
export enum DropinType {
  /*
   * The embedded drop-in type which is rendered within the page.
   */
  embedded = "embedded",
  /*
   * The hosted payment page (HPP) drop-in type which redirects the user to a hosted payment page.
   */
  hpp = "hpp",
}

/**
 * Represents the interface for a drop-in component.
 */
export interface DropinComponent {
  /**
   * Submits the drop-in component.
   */
  submit(): void;

  /**
   * Mounts the drop-in component to the specified selector.
   * @param selector - The selector where the drop-in component will be mounted.
   */
  mount(selector: string): void;
}

/**
 * Represents the options for a drop-in component.
 */
export type DropinOptions = {
  /**
   * Indicates whether to show the pay button.
   **/
  showPayButton?: boolean;

  /**
   * A callback function that is called when the drop-in component is ready.
   * @returns A Promise indicating whether the drop-in component is ready.
   */
  onDropinReady?: () => Promise<void>;

  /**
   * A callback function that is called when the pay button is clicked.
   * @returns A Promise indicating whether the payment should proceed.
   */
  onPayButtonClick?: () => Promise<void>;
};

/**
 * Represents the interface for a payment drop-in builder.
 */
export interface PaymentDropinBuilder {
  /**
   * Indicates whether the drop-in component has a submit action.
   */
  dropinHasSubmit: boolean;

  /**
   * Builds a drop-in component with the specified configuration.
   * @param config - The configuration options for the drop-in component.
   * @returns The built drop-in component.
   */
  build(config: DropinOptions): DropinComponent;
}

/**
 * Represents the interface for an express checkout builder.
 */
export interface PaymentExpressBuilder {
  /**
   * Builds an express checkout component with the specified configuration.
   * @param config - The configuration options for the express checkout component.
   * @returns The built express checkout component.
   */
  build(config: ExpressOptions): ExpressComponent;
}

/**
 * Represents the interface for an express checkout component.
 */
export interface ExpressComponent {
  /**
   * Mounts the express checkout component to the specified selector.
   * @param selector - The selector where the component will be mounted.
   */
  mount(selector: string): void | Promise<void>;
}

/**
 * Represents address data in commercetools format.
 */
export type ExpressAddressData = {
  country: string;
  city?: string;
  postalCode?: string;
  state?: string;
  streetName?: string;
  streetNumber?: string;
  additionalStreetInfo?: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
  mobile?: string;
  email?: string;
};

/**
 * Represents shipping option data in commercetools format.
 */
export type ExpressShippingOptionData = {
  id: string;
  name?: string;
  description?: string;
  amount?: {
    centAmount: number;
    currencyCode: string;
  };
};

/**
 * Represents the result of express checkout completion.
 */
export type OnComplete = {
  isSuccess: boolean;
  paymentReference?: string;
};

/**
 * Response from onPayButtonClick callback.
 */
export type OnclickResponse = {
  sessionId: string;
};

/**
 * Represents an amount in commercetools format.
 */
export type CTAmount = {
  centAmount: number;
  currencyCode: string;
  fractionDigits: number;
};

/**
 * Response from GET /express-payment-data (commercetools-oriented totals and line items for Express).
 * Used by the enabler to update amount and line items after shipping address/method changes.
 */
export type InitialPaymentData = {
  totalPrice: CTAmount;
  lineItems: {
    name: string;
    amount: CTAmount;
    type: string;
  }[];
  currencyCode: string;
};

/**
 * Payload for {@link ExpressOptions.onPaymentSubmit} after the wallet authorizes payment.
 * Only defined properties should be applied to the cart or checkout session: the enabler omits
 * keys when data is missing so hosts do not send empty `setShippingAddress` updates while a
 * shipping method remains set.
 */
export type ExpressPaymentSubmitPayload = {
  /**
   * Present when the Express element exposed a shipping address with a country.
   */
  shippingAddress?: ExpressAddressData;
  /**
   * Present when the Express element exposed a billing address with a country.
   */
  billingAddress?: ExpressAddressData;
  /**
   * Present when a non-empty email was derived from billing or shipping data.
   */
  customerEmail?: string;
};

/**
 * Represents the options for an express checkout component.
 * Shaped for commercetools Checkout Express integration (callbacks and session flow).
 */
export type ExpressOptions = {
  /**
   * Optional. Restrict express checkout to these country codes (ISO 3166-1 alpha-2), per Express UX expectations.
   */
  allowedCountries?: string[];

  /**
   * Invoked on every Express wallet open (Stripe `click` on ExpressCheckoutElement) so checkout returns
   * the commercetools Connect checkout session id for the current cart (`sessionId` in {@link OnclickResponse}).
   * Also used as a fallback when shipping or confirm runs before the async session from `click` has settled (`ensureSessionId`).
   * Should be safe to call repeatedly (e.g. idempotent session reuse) so overlapping click + fallback does not create duplicate carts.
   */
  onPayButtonClick: () => Promise<OnclickResponse>;

  /**
   * A callback function that receives an address event when the buyer selects a shipping address in the express checkout pop up.
   * @param opts - The address event received.
   */
  onShippingAddressSelected: (opts: {
    address: ExpressAddressData;
  }) => Promise<void>;

  /**
   * A callback function that retrieves the list of available shipping methods.
   * @param opts - The address to fetch available shipping methods.
   * @returns A promise that resolves to an array of shipping options.
   */
  getShippingMethods: (opts: {
    address: ExpressAddressData;
  }) => Promise<ExpressShippingOptionData[]>;

  /**
   * A callback function that receives a shipping method event when the buyer selects a shipping method in the express checkout pop up.
   * @param opts - The shippingMethod event received.
   */
  onShippingMethodSelected: (opts: {
    shippingMethod: { id: string };
  }) => Promise<void>;

  /**
   * Called when payment is authorized, before the processor creates the PaymentIntent.
   * Receives a partial {@link ExpressPaymentSubmitPayload}: update only properties that are defined.
   * Omitted when Stripe does not expose shipping, billing, or email and the cart was already
   * updated via `onShippingAddressSelected` / `onShippingMethodSelected`.
   * @param opts - Optional shipping address, billing address, and customer email from the Express flow.
   */
  onPaymentSubmit: (opts: ExpressPaymentSubmitPayload) => Promise<void>;

  /**
   * Callback function called when the payment is completed.
   * @param result - The completion result.
   */
  onComplete?: (result: OnComplete) => void;

  /**
   * Callback function called when an error occurs.
   * @param error - The error that occurred.
   */
  onError?: (error: any) => void;

  /**
   * Initial amount for the express checkout.
   * This is used to initialize the Stripe ExpressCheckoutElement.
   */
  initialAmount: CTAmount;
};
