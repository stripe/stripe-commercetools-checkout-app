import Stripe from 'stripe';
import {
  CollectBillingAddressOptions,
  ConfigElementResponseSchemaDTO,
  CustomerResponseSchemaDTO,
  PaymentResponseSchemaDTO,
} from '../../src/dtos/stripe-payment.dto';
import { SupportedPaymentComponentsSchemaDTO } from '../../src/dtos/operations/payment-componets.dto';
import {
  PaymentIntentResponseSchemaDTO,
  PaymentModificationStatus,
} from '../../src/dtos/operations/payment-intents.dto';
import { ModifyPayment } from '../../src/services/types/operation.type';

const commonData = {
  object: {
    id: 'pi_11111',
    object: 'payment_intent',
    amount: 12300,
    amount_capturable: 12300,
    amount_details: {
      tip: {},
    },
    amount_received: 0,
    application: null,
    application_fee_amount: null,
    automatic_payment_methods: null,
    canceled_at: null,
    cancellation_reason: null,
    capture_method: 'manual',
    client_secret: 'pi_22222',
    confirmation_method: 'automatic',
    created: 1717093717,
    currency: 'mxn',
    customer: null,
    customer_account: null,
    description: 'Sport shoes',
    last_payment_error: null,
    latest_charge: 'ch_11111',
    livemode: false,
    metadata: {},
    next_action: null,
    on_behalf_of: null,
    payment_method: 'pm_11111',
    payment_method_configuration_details: null,
    payment_method_options: {
      card: {
        installments: null,
        mandate_options: null,
        network: null,
        request_three_d_secure: 'automatic',
      },
    },
    payment_method_types: ['card'],
    excluded_payment_method_types: [],
    processing: null,
    receipt_email: null,
    review: null,
    setup_future_usage: null,
    shipping: null,
    source: null,
    statement_descriptor: 'Payment',
    statement_descriptor_suffix: null,
    status: 'requires_capture',
    transfer_data: null,
    transfer_group: null,
  },
} as Stripe.PaymentIntentProcessingEvent.Data;

const commonPaymentMethodDetails = {
  card: {
    amount_authorized: 123100,
    brand: 'visa',
    capture_before: 1718911059,
    checks: {
      address_line1_check: null,
      address_postal_code_check: 'pass',
      cvc_check: 'pass',
    },
    country: 'US',
    exp_month: 12,
    exp_year: 2025,
    extended_authorization: {
      status: 'disabled',
    },
    fingerprint: '11111',
    funding: 'credit',
    incremental_authorization: {
      status: 'unavailable',
    },
    installments: null,
    last4: '1111',
    mandate: null,
    multicapture: {
      status: 'unavailable',
    },
    network: 'visa',
    network_token: {
      used: false,
    },
    overcapture: {
      maximum_amount_capturable: 123100,
      status: 'unavailable',
    },
    three_d_secure: null,
    wallet: null,
  },
  type: 'card',
} as Stripe.Charge.PaymentMethodDetails;

const commonBillingDetails = {
  address: {
    city: null,
    country: null,
    line1: null,
    line2: null,
    postal_code: '12312',
    state: null,
  },
  email: null,
  name: null,
  phone: null,
  tax_id: null,
} as Stripe.Charge.BillingDetails;

const commonPaymentMethodDetails2 = {
  card: {
    amount_authorized: 34500,
    brand: 'visa',
    checks: {
      address_line1_check: null,
      address_postal_code_check: 'pass',
      cvc_check: 'pass',
    },
    country: 'US',
    exp_month: 12,
    exp_year: 2026,
    extended_authorization: {
      status: 'disabled',
    },
    fingerprint: '12345',
    funding: 'credit',
    incremental_authorization: {
      status: 'unavailable',
    },
    installments: null,
    last4: '1111',
    mandate: null,
    multicapture: {
      status: 'unavailable',
    },
    network: 'visa',
    network_token: {
      used: false,
    },
    overcapture: {
      maximum_amount_capturable: 34500,
      status: 'unavailable',
    },
    three_d_secure: null,
    wallet: null,
  },
  type: 'card',
} as Stripe.Charge.PaymentMethodDetails;

export const mockEvent__paymentIntent_paymentFailed: Stripe.Event = {
  id: 'evt_11111',
  object: 'event',
  api_version: '2024-04-10',
  created: 1717093717,
  data: commonData,
  livemode: false,
  pending_webhooks: 1,
  request: {
    id: 'req_11111',
    idempotency_key: '11111',
  },
  type: 'payment_intent.payment_failed',
};

export const mockEvent__paymentIntent_succeeded_captureMethodManual: Stripe.Event = {
  id: 'evt_11111',
  object: 'event',
  api_version: '2024-04-10',
  created: 1717692258,
  data: {
    object: {
      id: 'pi_11111',
      object: 'payment_intent',
      amount: 13200,
      amount_capturable: 0,
      amount_details: {
        tip: {},
      },
      amount_received: 13200,
      application: null,
      application_fee_amount: null,
      automatic_payment_methods: null,
      canceled_at: null,
      cancellation_reason: null,
      capture_method: 'manual',
      client_secret: 'pi_11111',
      confirmation_method: 'automatic',
      created: 1717452163,
      currency: 'mxn',
      customer: null,
      customer_account: null,
      description: 'Sport shoes',
      last_payment_error: null,
      latest_charge: 'ch_11111',
      livemode: false,
      metadata: {},
      next_action: null,
      on_behalf_of: null,
      payment_method: 'pm_11111',
      payment_method_configuration_details: null,
      payment_method_options: {
        card: {
          installments: null,
          mandate_options: null,
          network: null,
          request_three_d_secure: 'automatic',
        },
      },
      payment_method_types: ['card'],
      excluded_payment_method_types: [],
      processing: null,
      receipt_email: null,
      review: null,
      setup_future_usage: null,
      shipping: null,
      source: null,
      statement_descriptor: 'Payment',
      statement_descriptor_suffix: null,
      status: 'succeeded',
      transfer_data: null,
      transfer_group: null,
    },
  },
  livemode: false,
  pending_webhooks: 1,
  request: {
    id: 'req_11111',
    idempotency_key: '11111-ABCDE',
  },
  type: 'payment_intent.succeeded',
};

export const mockEvent__paymentIntent_succeeded_captureMethodAutomatic: Stripe.Event = {
  id: 'evt_11111',
  object: 'event',
  api_version: '2024-04-10',
  created: 1717692258,
  data: {
    object: {
      id: 'pi_11111',
      object: 'payment_intent',
      amount: 13200,
      amount_capturable: 0,
      amount_details: {
        tip: {},
      },
      amount_received: 13200,
      application: null,
      application_fee_amount: null,
      automatic_payment_methods: null,
      canceled_at: null,
      cancellation_reason: null,
      capture_method: 'automatic',
      client_secret: 'pi_11111',
      confirmation_method: 'automatic',
      created: 1717452163,
      currency: 'mxn',
      customer: null,
      customer_account: null,
      description: 'Sport shoes',
      last_payment_error: null,
      latest_charge: 'ch_11111',
      livemode: false,
      metadata: {
        ct_payment_id: 'pi_11111',
      },
      next_action: null,
      on_behalf_of: null,
      payment_method: 'pm_11111',
      payment_method_configuration_details: null,
      payment_method_options: {
        card: {
          installments: null,
          mandate_options: null,
          network: null,
          request_three_d_secure: 'automatic',
        },
      },
      payment_method_types: ['card'],
      excluded_payment_method_types: [],
      processing: null,
      receipt_email: null,
      review: null,
      setup_future_usage: null,
      shipping: null,
      source: null,
      statement_descriptor: 'Payment',
      statement_descriptor_suffix: null,
      status: 'succeeded',
      transfer_data: null,
      transfer_group: null,
    },
  },
  livemode: false,
  pending_webhooks: 1,
  request: {
    id: 'req_11111',
    idempotency_key: '11111-ABCDE',
  },
  type: 'payment_intent.succeeded',
};

// Async payment methods (e.g. crypto/stablecoin) emit payment_intent.processing while the
// deposit settles. amount_received is still 0 at this point, so the pending amount must be
// read from `amount`, never `amount_received`.
export const mockEvent__paymentIntent_processing: Stripe.Event = {
  ...mockEvent__paymentIntent_succeeded_captureMethodAutomatic,
  data: {
    object: {
      ...mockEvent__paymentIntent_succeeded_captureMethodAutomatic.data.object,
      amount_received: 0,
      status: 'processing',
    } as Stripe.PaymentIntent,
  },
  type: 'payment_intent.processing',
};

// Redirect-based async methods emit payment_intent.requires_action while the buyer is on the
// Stripe-hosted page. No CT transaction is written for this transient state.
export const mockEvent__paymentIntent_requiresAction: Stripe.Event = {
  ...mockEvent__paymentIntent_succeeded_captureMethodAutomatic,
  data: {
    object: {
      ...mockEvent__paymentIntent_succeeded_captureMethodAutomatic.data.object,
      amount_received: 0,
      status: 'requires_action',
    } as Stripe.PaymentIntent,
  },
  type: 'payment_intent.requires_action',
};

export const mockEvent__charge_refund_captured: Stripe.Event = {
  id: 'evt_11111',
  object: 'event',
  api_version: '2024-04-10',
  created: 1717531265,
  data: {
    object: {
      id: 'ch_11111',
      object: 'charge',
      amount: 34500,
      amount_captured: 34500,
      amount_refunded: 34500,
      application: null,
      application_fee: null,
      application_fee_amount: null,
      balance_transaction: 'txn_11111',
      billing_details: commonBillingDetails,
      calculated_statement_descriptor: 'ABCDE',
      captured: true,
      created: 1717529587,
      currency: 'mxn',
      customer: null,
      description: 'Sport shoes',
      disputed: false,
      failure_balance_transaction: null,
      failure_code: null,
      failure_message: null,
      fraud_details: {},
      livemode: false,
      metadata: {
        ct_payment_id: 'pi_11111',
      },
      on_behalf_of: null,
      outcome: {
        network_status: 'approved_by_network',
        reason: null,
        risk_level: 'normal',
        risk_score: 8,
        seller_message: 'Payment complete.',
        type: 'authorized',
        advice_code: 'try_again_later',
        network_advice_code: 'mock_advice_code',
        network_decline_code: 'mock_decline_code',
      },
      paid: true,
      payment_intent: 'pi_11111',
      payment_method: 'pm_11111',
      payment_method_details: commonPaymentMethodDetails2,
      radar_options: {},
      receipt_email: null,
      receipt_number: null,
      receipt_url: 'https://pay.stripe.com/receipts/payment/ABCDE',
      refunded: true,
      review: null,
      shipping: null,
      source: null,
      source_transfer: null,
      statement_descriptor: 'ABCDE',
      statement_descriptor_suffix: null,
      status: 'succeeded',
      transfer_data: null,
      transfer_group: null,
    },
    previous_attributes: {
      amount_refunded: 0,
      receipt_url: 'https://pay.stripe.com/receipts/payment/ABCDE',
      refunded: false,
    },
  },
  livemode: false,
  pending_webhooks: 1,
  request: {
    id: 'req_11111',
    idempotency_key: '12345',
  },
  type: 'charge.refunded',
};

export const mockEvent__charge_refund_notCaptured: Stripe.Event = {
  id: 'evt_11111',
  object: 'event',
  api_version: '2024-04-10',
  created: 1717531265,
  data: {
    object: {
      id: 'ch_11111',
      object: 'charge',
      amount: 34500,
      amount_captured: 34500,
      amount_refunded: 34500,
      application: null,
      application_fee: null,
      application_fee_amount: null,
      balance_transaction: 'txn_11111',
      billing_details: commonBillingDetails,
      calculated_statement_descriptor: 'ABCDE',
      captured: false,
      created: 1717529587,
      currency: 'mxn',
      customer: null,
      description: 'Sport shoes',
      disputed: false,
      failure_balance_transaction: null,
      failure_code: null,
      failure_message: null,
      fraud_details: {},
      livemode: false,
      metadata: {
        ct_payment_id: 'pi_11111',
      },
      on_behalf_of: null,
      outcome: {
        network_status: 'approved_by_network',
        reason: null,
        risk_level: 'normal',
        risk_score: 8,
        seller_message: 'Payment complete.',
        type: 'authorized',
        advice_code: 'try_again_later',
        network_advice_code: 'mock_advice_code',
        network_decline_code: 'mock_decline_code',
      },
      paid: true,
      payment_intent: 'pi_11111',
      payment_method: 'pm_11111',
      payment_method_details: commonPaymentMethodDetails2,
      radar_options: {},
      receipt_email: null,
      receipt_number: null,
      receipt_url: 'https://pay.stripe.com/receipts/payment/ABCDE',
      refunded: true,
      review: null,
      shipping: null,
      source: null,
      source_transfer: null,
      statement_descriptor: 'ABCDE',
      statement_descriptor_suffix: null,
      status: 'succeeded',
      transfer_data: null,
      transfer_group: null,
    },
    previous_attributes: {
      amount_refunded: 0,
      receipt_url: 'https://pay.stripe.com/receipts/payment/ABCDE',
      refunded: false,
    },
  },
  livemode: false,
  pending_webhooks: 1,
  request: {
    id: 'req_11111',
    idempotency_key: '12345',
  },
  type: 'charge.refunded',
};

export const mockEvent__paymentIntent_canceled: Stripe.Event = {
  id: 'evt_11111',
  object: 'event',
  api_version: '2024-04-10',
  created: 1717607367,
  data: {
    object: {
      id: 'pi_11111',
      object: 'payment_intent',
      amount: 45600,
      amount_capturable: 0,
      amount_details: {
        tip: {},
      },
      amount_received: 0,
      application: null,
      application_fee_amount: null,
      automatic_payment_methods: null,
      canceled_at: 1717607367,
      cancellation_reason: 'requested_by_customer',
      capture_method: 'manual',
      client_secret: 'pi_11111AAAAA',
      confirmation_method: 'automatic',
      created: 1717452983,
      currency: 'mxn',
      customer: null,
      customer_account: null,
      description: 'Sport shoes',
      last_payment_error: null,
      latest_charge: 'ch_11111',
      livemode: false,
      metadata: {
        ct_payment_id: 'pi_11111',
      },
      next_action: null,
      on_behalf_of: null,
      payment_method: 'pm_11111',
      payment_method_configuration_details: null,
      payment_method_options: {
        card: {
          installments: null,
          mandate_options: null,
          network: null,
          request_three_d_secure: 'automatic',
        },
      },
      payment_method_types: ['card'],
      excluded_payment_method_types: [],
      processing: null,
      receipt_email: null,
      review: null,
      setup_future_usage: null,
      shipping: null,
      source: null,
      statement_descriptor: 'asdad',
      statement_descriptor_suffix: null,
      status: 'canceled',
      transfer_data: null,
      transfer_group: null,
    },
  },
  livemode: false,
  pending_webhooks: 1,
  request: {
    id: 'req_11111',
    idempotency_key: 'ASDFG-12345',
  },
  type: 'payment_intent.canceled',
};

export const mockRoute__payments_succeed: PaymentResponseSchemaDTO = {
  sClientSecret: 'mock_paymentReference',
  paymentReference: 'mock_paymentReference',
  merchantReturnUrl: 'mock_merchantReturnUrl',
  cartId: 'mockCartId',
};

export const mockRoute__paymentsComponents_succeed: SupportedPaymentComponentsSchemaDTO = {
  dropins: [
    {
      type: 'embedded',
    },
  ],
  components: [
    {
      type: 'payment',
    },
    {
      type: 'expressCheckout',
    },
  ],
  express: [
    {
      type: 'dropin',
    },
  ],
};

export const mockRoute__paymentIntent_succeed: PaymentIntentResponseSchemaDTO = {
  outcome: PaymentModificationStatus.APPROVED,
};

export const mockRoute__get_config_element_succeed: ConfigElementResponseSchemaDTO = {
  cartInfo: {
    currency: 'usd',
    amount: 10000,
  },
  appearance: '',
  captureMethod: 'captureMethod',
  setupFutureUsage: 'on_session',
  layout: '{"type":"accordion","defaultCollapsed":false,"radios":true,"spacedAccordionItems":true}',
  collectBillingAddress: CollectBillingAddressOptions.AUTO,
  paymentElementOptions: '{}',
};

export const mockEvent__charge_capture_succeeded_notCaptured: Stripe.Event = {
  id: 'evt_11111',
  object: 'event',
  api_version: '2024-04-10',
  created: 1718306259,
  data: {
    object: {
      id: 'ch_11111',
      object: 'charge',
      amount: 123100,
      amount_captured: 0,
      amount_refunded: 0,
      application: null,
      application_fee: null,
      application_fee_amount: null,
      balance_transaction: null,
      billing_details: commonBillingDetails,
      calculated_statement_descriptor: 'AAAAAAA',
      captured: false,
      created: 1718306259,
      currency: 'mxn',
      customer: null,
      description: 'Manual payment',
      disputed: false,
      failure_balance_transaction: null,
      failure_code: null,
      failure_message: null,
      fraud_details: {},
      livemode: false,
      metadata: {
        cart_id: '11111-22222',
      },
      on_behalf_of: null,
      outcome: {
        network_status: 'approved_by_network',
        reason: null,
        risk_level: 'normal',
        risk_score: 14,
        seller_message: 'Payment complete.',
        type: 'authorized',
        advice_code: 'try_again_later',
        network_advice_code: 'mock_advice_code',
        network_decline_code: 'mock_decline_code',
      },
      paid: true,
      payment_intent: 'pi_11111',
      payment_method: 'pm_11111',
      payment_method_details: commonPaymentMethodDetails,
      radar_options: {},
      receipt_email: null,
      receipt_number: null,
      receipt_url: 'https://pay.stripe.com/receipts/payment/11111',
      refunded: false,
      review: null,
      shipping: null,
      source: null,
      source_transfer: null,
      statement_descriptor: 'aaaaaaa',
      statement_descriptor_suffix: null,
      status: 'succeeded',
      transfer_data: null,
      transfer_group: null,
    },
  },
  livemode: false,
  pending_webhooks: 1,
  request: {
    id: 'req_11111',
    idempotency_key: '7ae634ca-11111',
  },
  type: 'charge.captured',
};

export const mockEvent__charge_succeeded_notCaptured: Stripe.Event = {
  id: 'evt_11111',
  object: 'event',
  api_version: '2024-04-10',
  created: 1718306259,
  data: {
    object: {
      id: 'ch_11111',
      object: 'charge',
      amount: 123100,
      amount_captured: 0,
      amount_refunded: 0,
      application: null,
      application_fee: null,
      application_fee_amount: null,
      balance_transaction: null,
      billing_details: commonBillingDetails,
      calculated_statement_descriptor: 'AAAAAAA',
      captured: false,
      created: 1718306259,
      currency: 'mxn',
      customer: null,
      description: 'Manual payment',
      disputed: false,
      failure_balance_transaction: null,
      failure_code: null,
      failure_message: null,
      fraud_details: {},
      livemode: false,
      metadata: {
        cart_id: '11111-22222',
        ct_payment_id: 'pi_11111',
      },
      on_behalf_of: null,
      outcome: {
        network_status: 'approved_by_network',
        reason: null,
        risk_level: 'normal',
        risk_score: 14,
        seller_message: 'Payment complete.',
        type: 'authorized',
        advice_code: 'try_again_later',
        network_advice_code: 'mock_advice_code',
        network_decline_code: 'mock_decline_code',
      },
      paid: true,
      payment_intent: 'pi_11111',
      payment_method: 'pm_11111',
      payment_method_details: commonPaymentMethodDetails,
      radar_options: {},
      receipt_email: null,
      receipt_number: null,
      receipt_url: 'https://pay.stripe.com/receipts/payment/11111',
      refunded: false,
      review: null,
      shipping: null,
      source: null,
      source_transfer: null,
      statement_descriptor: 'aaaaaaa',
      statement_descriptor_suffix: null,
      status: 'succeeded',
      transfer_data: null,
      transfer_group: null,
    },
  },
  livemode: false,
  pending_webhooks: 1,
  request: {
    id: 'req_11111',
    idempotency_key: '7ae634ca-11111',
  },
  type: 'charge.succeeded',
};

export const mockEvent__charge_succeeded_captured: Stripe.Event = {
  id: 'evt_11111',
  object: 'event',
  api_version: '2024-04-10',
  created: 1718306259,
  data: {
    object: {
      id: 'ch_11111',
      object: 'charge',
      amount: 123100,
      amount_captured: 123100,
      amount_refunded: 0,
      application: null,
      application_fee: null,
      application_fee_amount: null,
      balance_transaction: null,
      billing_details: commonBillingDetails,
      calculated_statement_descriptor: 'AAAAAAA',
      captured: true,
      created: 1718306259,
      currency: 'mxn',
      customer: null,
      description: 'Manual payment',
      disputed: false,
      failure_balance_transaction: null,
      failure_code: null,
      failure_message: null,
      fraud_details: {},
      livemode: false,
      metadata: {
        cart_id: '11111-22222',
      },
      on_behalf_of: null,
      outcome: {
        network_status: 'approved_by_network',
        reason: null,
        risk_level: 'normal',
        risk_score: 14,
        seller_message: 'Payment complete.',
        type: 'authorized',
        advice_code: 'try_again_later',
        network_advice_code: 'mock_advice_code',
        network_decline_code: 'mock_decline_code',
      },
      paid: true,
      payment_intent: 'pi_11111',
      payment_method: 'pm_11111',
      payment_method_details: commonPaymentMethodDetails,
      radar_options: {},
      receipt_email: null,
      receipt_number: null,
      receipt_url: 'https://pay.stripe.com/receipts/payment/11111',
      refunded: false,
      review: null,
      shipping: null,
      source: null,
      source_transfer: null,
      statement_descriptor: 'aaaaaaa',
      statement_descriptor_suffix: null,
      status: 'succeeded',
      transfer_data: null,
      transfer_group: null,
    },
  },
  livemode: false,
  pending_webhooks: 1,
  request: {
    id: 'req_11111',
    idempotency_key: '7ae634ca-11111',
  },
  type: 'charge.succeeded',
};

export const mockModifyPayment__payment_intent_succeeded: ModifyPayment = {
  paymentId: 'mockPaymentId',
  data: {
    actions: [
      {
        action: 'capturePayment',
        amount: {
          centAmount: 1500,
          currencyCode: 'USD',
        },
      },
    ],
  },
};

export const mockModifyPayment__charge_refunded: ModifyPayment = {
  paymentId: 'mockPaymentId',
  data: {
    actions: [
      {
        action: 'refundPayment',
        amount: {
          centAmount: 1500,
          currencyCode: 'USD',
        },
      },
    ],
  },
};

export const mockModifyPayment__payment_intent_canceled: ModifyPayment = {
  paymentId: 'mockPaymentId',
  data: {
    actions: [
      {
        action: 'cancelPayment',
      },
    ],
  },
};

export const mockRoute__well_know__succeed: string = 'mockWellKnowString';

export const mockRoute__customer_session_succeed: CustomerResponseSchemaDTO = {
  ephemeralKey: 'mockEphemeralKey',
  sessionId: 'mockSessionId',
  stripeCustomerId: 'mockStripeCustomerId',
};

// Mock for multicapture payment intent event
export const mockEvent__paymentIntent_succeeded_multicapture: Stripe.Event = {
  id: 'evt_multicapture',
  object: 'event',
  api_version: '2024-04-10',
  created: 1717692258,
  data: {
    object: {
      id: 'pi_multicapture',
      object: 'payment_intent',
      amount: 100000,
      amount_capturable: 0,
      amount_details: {
        tip: {},
      },
      amount_received: 50000,
      application: null,
      application_fee_amount: null,
      automatic_payment_methods: null,
      canceled_at: null,
      cancellation_reason: null,
      capture_method: 'manual',
      client_secret: 'pi_multicapture_secret',
      confirmation_method: 'automatic',
      created: 1717452163,
      currency: 'usd',
      customer: null,
      customer_account: null,
      description: 'Multicapture payment',
      last_payment_error: null,
      latest_charge: 'ch_multicapture',
      livemode: false,
      metadata: {
        ct_payment_id: 'ct_payment_multicapture',
      },
      next_action: null,
      on_behalf_of: null,
      payment_method: 'pm_multicapture',
      payment_method_configuration_details: null,
      payment_method_options: {
        card: {
          installments: null,
          mandate_options: null,
          network: null,
          request_three_d_secure: 'automatic',
          request_multicapture: 'if_available',
        },
      },
      payment_method_types: ['card'],
      excluded_payment_method_types: [],
      processing: null,
      receipt_email: null,
      review: null,
      setup_future_usage: null,
      shipping: null,
      source: null,
      statement_descriptor: 'Multicapture',
      statement_descriptor_suffix: null,
      status: 'requires_capture',
      transfer_data: null,
      transfer_group: null,
    },
  },
  livemode: false,
  pending_webhooks: 1,
  request: {
    id: 'req_multicapture',
    idempotency_key: 'multicapture-key',
  },
  type: 'payment_intent.succeeded',
};

// Mock for charge.updated event (for processStripeEventMultipleCaptured)
export const mockEvent__charge_updated_multicapture: Stripe.Event = {
  id: 'evt_charge_updated',
  object: 'event',
  api_version: '2024-04-10',
  created: 1718306259,
  data: {
    object: {
      id: 'ch_multicapture',
      object: 'charge',
      amount: 100000,
      amount_captured: 50000,
      amount_refunded: 0,
      application: null,
      application_fee: null,
      application_fee_amount: null,
      balance_transaction: 'txn_multicapture',
      billing_details: commonBillingDetails,
      calculated_statement_descriptor: 'MULTICAPTURE',
      captured: false,
      created: 1718306259,
      currency: 'usd',
      customer: null,
      description: 'Multicapture payment',
      disputed: false,
      failure_balance_transaction: null,
      failure_code: null,
      failure_message: null,
      fraud_details: {},
      livemode: false,
      metadata: {
        ct_payment_id: 'ct_payment_multicapture',
      },
      on_behalf_of: null,
      outcome: {
        network_status: 'approved_by_network',
        reason: null,
        risk_level: 'normal',
        risk_score: 14,
        seller_message: 'Payment complete.',
        type: 'authorized',
        advice_code: 'try_again_later',
        network_advice_code: 'mock_advice_code',
        network_decline_code: 'mock_decline_code',
      },
      paid: true,
      payment_intent: 'pi_multicapture',
      payment_method: 'pm_multicapture',
      payment_method_details: commonPaymentMethodDetails,
      radar_options: {},
      receipt_email: null,
      receipt_number: null,
      receipt_url: 'https://pay.stripe.com/receipts/payment/multicapture',
      refunded: false,
      review: null,
      shipping: null,
      source: null,
      source_transfer: null,
      statement_descriptor: 'multicapture',
      statement_descriptor_suffix: null,
      status: 'succeeded',
      transfer_data: null,
      transfer_group: null,
    },
    previous_attributes: {
      amount_captured: 25000,
    },
  },
  livemode: false,
  pending_webhooks: 1,
  request: {
    id: 'req_charge_updated',
    idempotency_key: 'charge-updated-key',
  },
  type: 'charge.updated',
};

// Mock for charge.updated event where captured is true (should skip)
export const mockEvent__charge_updated_already_captured: Stripe.Event = {
  id: 'evt_charge_updated_captured',
  object: 'event',
  api_version: '2024-04-10',
  created: 1718306259,
  data: {
    object: {
      id: 'ch_already_captured',
      object: 'charge',
      amount: 100000,
      amount_captured: 100000,
      amount_refunded: 0,
      application: null,
      application_fee: null,
      application_fee_amount: null,
      balance_transaction: 'txn_captured',
      billing_details: commonBillingDetails,
      calculated_statement_descriptor: 'CAPTURED',
      captured: true,
      created: 1718306259,
      currency: 'usd',
      customer: null,
      description: 'Already captured',
      disputed: false,
      failure_balance_transaction: null,
      failure_code: null,
      failure_message: null,
      fraud_details: {},
      livemode: false,
      metadata: {
        ct_payment_id: 'ct_payment_captured',
      },
      on_behalf_of: null,
      outcome: {
        network_status: 'approved_by_network',
        reason: null,
        risk_level: 'normal',
        risk_score: 14,
        seller_message: 'Payment complete.',
        type: 'authorized',
        advice_code: 'try_again_later',
        network_advice_code: 'mock_advice_code',
        network_decline_code: 'mock_decline_code',
      },
      paid: true,
      payment_intent: 'pi_captured',
      payment_method: 'pm_captured',
      payment_method_details: commonPaymentMethodDetails,
      radar_options: {},
      receipt_email: null,
      receipt_number: null,
      receipt_url: 'https://pay.stripe.com/receipts/payment/captured',
      refunded: false,
      review: null,
      shipping: null,
      source: null,
      source_transfer: null,
      statement_descriptor: 'captured',
      statement_descriptor_suffix: null,
      status: 'succeeded',
      transfer_data: null,
      transfer_group: null,
    },
    previous_attributes: {
      amount_captured: 0,
    },
  },
  livemode: false,
  pending_webhooks: 1,
  request: {
    id: 'req_charge_captured',
    idempotency_key: 'charge-captured-key',
  },
  type: 'charge.updated',
};

// Mock for charge.updated event where amount_captured did not change
export const mockEvent__charge_updated_no_amount_change: Stripe.Event = {
  id: 'evt_charge_no_change',
  object: 'event',
  api_version: '2024-04-10',
  created: 1718306259,
  data: {
    object: {
      id: 'ch_no_change',
      object: 'charge',
      amount: 100000,
      amount_captured: 50000,
      amount_refunded: 0,
      application: null,
      application_fee: null,
      application_fee_amount: null,
      balance_transaction: 'txn_no_change',
      billing_details: commonBillingDetails,
      calculated_statement_descriptor: 'NOCHANGE',
      captured: false,
      created: 1718306259,
      currency: 'usd',
      customer: null,
      description: 'No amount change',
      disputed: false,
      failure_balance_transaction: null,
      failure_code: null,
      failure_message: null,
      fraud_details: {},
      livemode: false,
      metadata: {
        ct_payment_id: 'ct_payment_no_change',
      },
      on_behalf_of: null,
      outcome: {
        network_status: 'approved_by_network',
        reason: null,
        risk_level: 'normal',
        risk_score: 14,
        seller_message: 'Payment complete.',
        type: 'authorized',
        advice_code: 'try_again_later',
        network_advice_code: 'mock_advice_code',
        network_decline_code: 'mock_decline_code',
      },
      paid: true,
      payment_intent: 'pi_no_change',
      payment_method: 'pm_no_change',
      payment_method_details: commonPaymentMethodDetails,
      radar_options: {},
      receipt_email: null,
      receipt_number: null,
      receipt_url: 'https://pay.stripe.com/receipts/payment/no_change',
      refunded: false,
      review: null,
      shipping: null,
      source: null,
      source_transfer: null,
      statement_descriptor: 'no_change',
      statement_descriptor_suffix: null,
      status: 'succeeded',
      transfer_data: null,
      transfer_group: null,
    },
    previous_attributes: {
      amount_captured: 50000,
    },
  },
  livemode: false,
  pending_webhooks: 1,
  request: {
    id: 'req_no_change',
    idempotency_key: 'no-change-key',
  },
  type: 'charge.updated',
};

// ---------------------------------------------------------------------------
// Bank transfer (customer_balance) fixture — SB3-207 Task C (pspInteraction redaction)
//
// The shape Stripe emits while a bank transfer is awaiting funds: status
// `requires_action`, `amount_received: 0` (the wire has not landed yet) and
// `next_action.display_bank_transfer_instructions` carrying the merchant's
// virtual account details.
//
// The event type is deliberately `payment_intent.requires_action`, which this
// connector's converter maps to NO transactions at all. That is what makes this
// fixture exercise the redaction without waking the path: it proves the change
// is inert, which is the whole reason this task can land before the webhook task.
// ---------------------------------------------------------------------------

const bankTransferAddress: Stripe.Address = {
  city: 'Berlin',
  country: 'DE',
  line1: 'Unter den Linden 1',
  line2: null,
  postal_code: '10117',
  state: null,
};

// Annotated as Stripe.PaymentIntent on purpose, not cast. An `as unknown as` here would
// disable structural checking and let the fixture keep a shape Stripe no longer emits — which
// is precisely how a redaction guard falls open in production while the suite stays green.
const bankTransferPaymentIntent: Stripe.PaymentIntent = {
  id: 'pi_bt_11111',
  object: 'payment_intent',
  amount: 12300,
  amount_capturable: 0,
  amount_details: { tip: {} },
  amount_received: 0,
  application: null,
  application_fee_amount: null,
  automatic_payment_methods: null,
  canceled_at: null,
  cancellation_reason: null,
  capture_method: 'automatic',
  client_secret: 'pi_bt_11111_secret',
  confirmation_method: 'automatic',
  created: 1717452163,
  currency: 'eur',
  customer: 'cus_11111',
  description: 'Sport shoes',
  last_payment_error: null,
  latest_charge: null,
  livemode: false,
  metadata: { ct_payment_id: 'ct_payment_bt_11111' },
  next_action: {
    type: 'display_bank_transfer_instructions',
    display_bank_transfer_instructions: {
      amount_remaining: 12300,
      currency: 'eur',
      financial_addresses: [
        {
          iban: {
            account_holder_address: bankTransferAddress,
            account_holder_name: 'Stripe Payments UK Limited',
            bank_address: bankTransferAddress,
            bic: 'BUKBGB22',
            country: 'DE',
            iban: 'DE89370400440532013000',
          },
          supported_networks: ['sepa'],
          type: 'iban',
        },
      ],
      hosted_instructions_url: 'https://payments.stripe.com/bank_transfer_instructions/test_11111',
      reference: 'BT-REF-11111',
      type: 'eu_bank_transfer',
    },
  },
  on_behalf_of: null,
  payment_method: 'pm_bt_11111',
  payment_method_configuration_details: null,
  payment_method_options: {},
  payment_method_types: ['customer_balance'],
  processing: null,
  receipt_email: null,
  review: null,
  setup_future_usage: null,
  shipping: null,
  source: null,
  statement_descriptor: 'Payment',
  statement_descriptor_suffix: null,
  status: 'requires_action',
  transfer_data: null,
  transfer_group: null,
};

export const mockEvent__paymentIntent_requiresAction_bankTransfer: Stripe.Event = {
  id: 'evt_bt_11111',
  object: 'event',
  api_version: '2024-04-10',
  created: 1717692258,
  data: { object: bankTransferPaymentIntent },
  livemode: false,
  pending_webhooks: 1,
  request: { id: 'req_11111', idempotency_key: '11111-BT' },
  type: 'payment_intent.requires_action',
} as unknown as Stripe.Event;

// ---------------------------------------------------------------------------
// next_action variant fixtures — SB3-207 task 015
//
// Built as a helper rather than as N frozen events so a new variant can be added
// in one line. Each carries the customer-facing artifact its real payload carries.
// The event type is `payment_intent.requires_action` throughout: that is what
// every one of these variants actually arrives on, and it maps to NO transaction
// in this connector, so these fixtures exercise the redaction without waking the path.
// ---------------------------------------------------------------------------

export const makeNextActionEvent = (type: string, payload: Record<string, unknown>): Stripe.Event =>
  ({
    id: `evt_na_${type}`,
    object: 'event',
    api_version: '2024-04-10',
    created: 1717692258,
    data: {
      object: {
        ...bankTransferPaymentIntent,
        id: 'pi_na_11111',
        client_secret: 'pi_na_11111_secret',
        next_action: { type, [type]: payload },
      },
    },
    livemode: false,
    pending_webhooks: 1,
    request: { id: 'req_na', idempotency_key: 'na-key' },
    type: 'payment_intent.requires_action',
  }) as unknown as Stripe.Event;

/** `url` embeds a LIVE payment_intent_client_secret as a query parameter. */
export const mockEvent__nextAction_redirectToUrl = makeNextActionEvent('redirect_to_url', {
  return_url: 'https://shop.example.com/return',
  url: 'https://hooks.stripe.com/redirect/authenticate/src_11111?client_secret=pi_na_11111_secret_LIVE',
});

export const mockEvent__nextAction_boleto = makeNextActionEvent('boleto_display_details', {
  expires_at: 1717700000,
  hosted_voucher_url: 'https://payments.stripe.com/boleto/voucher/test_11111',
  number: '34191790010104351004791020150008291070026000',
  pdf: 'https://payments.stripe.com/boleto/voucher/test_11111/pdf',
});

export const mockEvent__nextAction_multibanco = makeNextActionEvent('multibanco_display_details', {
  entity: '12345',
  reference: 'MB-REF-11111',
  expires_at: 1717700000,
  hosted_voucher_url: 'https://payments.stripe.com/multibanco/voucher/test_11111',
});

export const mockEvent__nextAction_microdeposits = makeNextActionEvent('verify_with_microdeposits', {
  arrival_date: 1717700000,
  hosted_verification_url: 'https://payments.stripe.com/microdeposit/test_11111',
  microdeposit_type: 'amounts',
});

export const mockEvent__nextAction_pix = makeNextActionEvent('pix_display_qr_code', {
  data: '00020126580014BR.GOV.BCB.PIX0136SECRET-PIX-PAYLOAD-11111',
  expires_at: 1717700000,
  hosted_instructions_url: 'https://payments.stripe.com/pix/test_11111',
  image_url_png: 'https://payments.stripe.com/pix/test_11111.png',
  image_url_svg: 'https://payments.stripe.com/pix/test_11111.svg',
});

/** 3DS. Carries no artifact of its own, but must still not leak the PI client_secret. */
export const mockEvent__nextAction_useStripeSdk = makeNextActionEvent('use_stripe_sdk', {
  type: 'three_d_secure_redirect',
  stripe_js: 'https://hooks.stripe.com/3d_secure_2/hosted?client_secret=pi_na_11111_secret_LIVE',
});

// ---------------------------------------------------------------------------
// Webhook routing fixtures — SB3-207 task 005
//
// The fixtures above exercise the CONVERTER (redaction). These exercise the
// ROUTE: which requires_action events reach processStripeEvent at all.
//
// The 3DS and Boleto events below are release-gate fixtures. They carry their
// own PaymentIntent ids so the log-only assertion can name the id it expects,
// which is what makes "logged only" distinguishable from "not handled".
// ---------------------------------------------------------------------------

/** Same PaymentIntent after a partial wire: only `amount_remaining` moves. */
export const mockEvent__paymentIntent_partiallyFunded_bankTransfer: Stripe.Event = {
  id: 'evt_bt_22222',
  object: 'event',
  api_version: '2024-04-10',
  created: 1717692300,
  data: {
    object: {
      ...bankTransferPaymentIntent,
      next_action: {
        type: 'display_bank_transfer_instructions',
        display_bank_transfer_instructions: {
          ...bankTransferPaymentIntent.next_action?.display_bank_transfer_instructions,
          amount_remaining: 4300,
        },
      },
    },
  },
  livemode: false,
  pending_webhooks: 1,
  request: { id: 'req_22222', idempotency_key: '22222-BT' },
  type: 'payment_intent.partially_funded',
} as unknown as Stripe.Event;

/**
 * Card 3DS also emits `payment_intent.requires_action`. This is the regression fixture for the
 * release gate: it must never reach processStripeEvent. If the next_action predicate is ever
 * removed or widened, every 3DS payment would get an Authorization/Pending written to
 * commercetools — the most severe regression this feature can cause.
 */
export const mockEvent__paymentIntent_requiresAction_3ds: Stripe.Event = {
  ...mockEvent__paymentIntent_requiresAction_bankTransfer,
  id: 'evt_3ds_11111',
  data: {
    object: {
      ...bankTransferPaymentIntent,
      id: 'pi_3ds_11111',
      currency: 'mxn',
      payment_method_types: ['card'],
      next_action: {
        type: 'use_stripe_sdk',
        use_stripe_sdk: { type: 'three_d_secure_redirect' },
      },
    },
  },
} as unknown as Stripe.Event;

/** Boleto also emits `requires_action`. Must stay log-only, exactly as today. */
export const mockEvent__paymentIntent_requiresAction_boleto: Stripe.Event = {
  ...mockEvent__paymentIntent_requiresAction_bankTransfer,
  id: 'evt_boleto_11111',
  data: {
    object: {
      ...bankTransferPaymentIntent,
      id: 'pi_boleto_11111',
      currency: 'brl',
      payment_method_types: ['boleto'],
      next_action: {
        type: 'boleto_display_details',
        boleto_display_details: {
          expires_at: 1717692999,
          hosted_voucher_url: 'https://payments.stripe.com/boleto/test_11111',
          number: '00000.00000 00000.000000 00000.000000 0 00000000000000',
          pdf: 'https://payments.stripe.com/boleto/test_11111/pdf',
        },
      },
    },
  },
} as unknown as Stripe.Event;

// ---------------------------------------------------------------------------
// customer_cash_balance_transaction.created — observability only.
//
// The PII fields below are deliberately populated: `sender_name`, `iban_last4`
// and `sort_code` are what the route's field-by-field log exists to keep out of
// the log sink. A fixture without them cannot prove the handler is selective.
// ---------------------------------------------------------------------------

const cashBalanceTransaction = {
  id: 'ccsbtxn_11111',
  object: 'customer_cash_balance_transaction',
  created: 1717692400,
  currency: 'eur',
  customer: 'cus_11111',
  ending_balance: 12300,
  livemode: false,
  net_amount: 12300,
  type: 'funded',
  funded: {
    bank_transfer: {
      eu_bank_transfer: {
        bic: 'BUKBGB22',
        iban_last4: '3000',
        sender_name: 'Erika Mustermann',
      },
      reference: 'BT-REF-11111',
      type: 'eu_bank_transfer',
    },
  },
};

/** The benign case: funds arrived and were applied to the PaymentIntent. */
export const mockEvent__customerCashBalanceTransaction_appliedToPayment: Stripe.Event = {
  id: 'evt_ccb_11111',
  object: 'event',
  api_version: '2024-04-10',
  created: 1717692400,
  data: {
    object: {
      ...cashBalanceTransaction,
      id: 'ccsbtxn_11111',
      type: 'applied_to_payment',
      applied_to_payment: { payment_intent: 'pi_bt_11111' },
    },
  },
  livemode: false,
  pending_webhooks: 1,
  request: { id: 'req_ccb_11111', idempotency_key: null },
  type: 'customer_cash_balance_transaction.created',
} as unknown as Stripe.Event;

/**
 * The alertable case: money was withdrawn AFTER the payment was credited. commercetools is not
 * updated — there is no v1 model for it — so the log line is the only signal an operator gets.
 */
export const mockEvent__customerCashBalanceTransaction_fundingReversed: Stripe.Event = {
  id: 'evt_ccb_22222',
  object: 'event',
  api_version: '2024-04-10',
  created: 1717692500,
  data: {
    object: {
      ...cashBalanceTransaction,
      id: 'ccsbtxn_22222',
      type: 'funding_reversed',
      net_amount: -12300,
      ending_balance: 0,
    },
  },
  livemode: false,
  pending_webhooks: 1,
  request: { id: 'req_ccb_22222', idempotency_key: null },
  type: 'customer_cash_balance_transaction.created',
} as unknown as Stripe.Event;

// ---------------------------------------------------------------------------
// refund.updated / refund.failed — only the failed outcome is acted on.
// ---------------------------------------------------------------------------

const failedRefund = {
  id: 're_11111',
  object: 'refund',
  amount: 12300,
  charge: 'ch_11111',
  created: 1717692600,
  currency: 'eur',
  failure_reason: 'insufficient_funds',
  metadata: { ct_payment_id: 'ct_payment_bt_11111' },
  payment_intent: 'pi_bt_11111',
  status: 'failed',
};

export const mockEvent__refund_failed: Stripe.Event = {
  id: 'evt_re_11111',
  object: 'event',
  api_version: '2024-04-10',
  created: 1717692600,
  data: { object: failedRefund },
  livemode: false,
  pending_webhooks: 1,
  request: { id: 'req_re_11111', idempotency_key: null },
  type: 'refund.failed',
} as unknown as Stripe.Event;

/** A Dashboard-issued refund carries no ct_payment_id stamp. Not an error — nothing to correct. */
export const mockEvent__refund_failed_noMetadata: Stripe.Event = {
  ...mockEvent__refund_failed,
  id: 'evt_re_22222',
  data: { object: { ...failedRefund, id: 're_22222', metadata: {} } },
} as unknown as Stripe.Event;

/** refund.updated fires on every rail with the terminal status. Success must change nothing. */
export const mockEvent__refund_updated_succeeded: Stripe.Event = {
  ...mockEvent__refund_failed,
  id: 'evt_re_33333',
  data: { object: { ...failedRefund, id: 're_33333', status: 'succeeded', failure_reason: null } },
  type: 'refund.updated',
} as unknown as Stripe.Event;

/** A refund canceled after creation is treated exactly like a failed one. */
export const mockEvent__refund_updated_canceled: Stripe.Event = {
  ...mockEvent__refund_failed,
  id: 'evt_re_44444',
  data: { object: { ...failedRefund, id: 're_44444', status: 'canceled', failure_reason: null } },
  type: 'refund.updated',
} as unknown as Stripe.Event;

// ---------------------------------------------------------------------------
// Foreign PaymentIntents — SB3-207 task 025
//
// A PaymentIntent this connector did not create: Dashboard-issued, or another
// integration on the same Stripe account. Stripe always returns `metadata: {}`
// on a PaymentIntent, so the realistic shape is an EMPTY metadata object rather
// than an absent one — `ct_payment_id` resolves to undefined and convert()
// succeeds. A fixture that omitted `metadata` entirely would make getCtPaymentId
// throw instead, which is a different failure and would test the wrong thing.
// ---------------------------------------------------------------------------

export const mockEvent__paymentIntent_requiresAction_foreign: Stripe.Event = {
  ...mockEvent__paymentIntent_requiresAction_bankTransfer,
  id: 'evt_foreign_11111',
  data: {
    object: {
      ...bankTransferPaymentIntent,
      id: 'pi_foreign_11111',
      metadata: {},
    },
  },
} as unknown as Stripe.Event;

export const mockEvent__paymentIntent_processing_foreign: Stripe.Event = {
  ...mockEvent__paymentIntent_requiresAction_bankTransfer,
  id: 'evt_foreign_22222',
  data: {
    object: {
      ...bankTransferPaymentIntent,
      id: 'pi_foreign_22222',
      metadata: {},
      next_action: null,
      status: 'processing',
    },
  },
  type: 'payment_intent.processing',
} as unknown as Stripe.Event;
