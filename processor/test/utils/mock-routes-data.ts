import Stripe from 'stripe';
import {
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
    description: 'Sport shoes',
    invoice: null,
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
} as Stripe.Charge.BillingDetails;

export const mockEvent__paymentIntent_processing: Stripe.Event = {
  id: 'evt_00000000000',
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
  type: 'payment_intent.processing',
};

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
      description: 'Sport shoes',
      invoice: null,
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
      description: 'Sport shoes',
      invoice: null,
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
      invoice: null,
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
      invoice: null,
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
      description: 'Sport shoes',
      invoice: null,
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
      invoice: null,
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
      invoice: null,
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
      invoice: null,
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

export const mockEvent__paymentIntent_requiresAction: Stripe.Event = {
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
  type: 'payment_intent.requires_action',
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
