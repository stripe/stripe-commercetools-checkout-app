import Stripe from 'stripe';
import { Customer } from '@commercetools/platform-sdk/dist/declarations/src/generated/models/customer';

export const mockCtCustomerId = '437906f7-1aaa-41dd-8775-3a03d8aa1258';

const lastResponse = {
  headers: {},
  requestId: '11111',
  statusCode: 200,
  apiVersion: '',
  idempotencyKey: '',
  stripeAccount: '',
};

export const mockStripeCustomerId = 'cus_Example';

export const mockEphemeralKeySecret = 'ephkey_123';

export const mockEphemeralKeyResult: Stripe.Response<Stripe.EphemeralKey> = {
  created: 1687991030,
  expires: 1687991030,
  id: 'ephkey_123',
  livemode: false,
  object: 'ephemeral_key',
  secret: mockEphemeralKeySecret,
  lastResponse,
};

export const mockCreateSessionResult: Stripe.Response<Stripe.CustomerSession> = {
  client_secret: 'cs_test_1234567890',
  created: 1687991030,
  livemode: false,
  customer: 'cus_Example',
  expires_at: 1687991030,
  object: 'customer_session',
  lastResponse,
};

export const mockCustomerData: Stripe.Response<Stripe.Customer> = {
  id: 'cus_Example',
  object: 'customer',
  balance: 0,
  created: 1742596970,
  currency: null,
  default_source: null,
  delinquent: false,
  description: null,
  discount: null,
  email: 'test@example.com',
  invoice_settings: {
    custom_fields: null,
    default_payment_method: null,
    footer: null,
    rendering_options: null,
  },
  livemode: false,
  metadata: { ct_customer_id: mockCtCustomerId },
  name: 'John Smith',
  next_invoice_sequence: 1,
  phone: null,
  preferred_locales: [],
  shipping: null,
  tax_exempt: 'none',
  test_clock: null,
  lastResponse,
};

export const mockCtCustomerData: Customer = {
  id: mockCtCustomerId,
  version: 1,
  createdAt: '2025-03-19T00:09:28.752Z',
  lastModifiedAt: '2025-03-19T00:48:46.632Z',
  email: 'test@example.com',
  firstName: 'Gildardo',
  lastName: 'Diaz',
  addresses: [
    {
      id: 'xxxxxx-test-id',
      country: 'US',
      city: 'San Francisco',
      state: 'CA',
      streetName: 'Main St',
      streetNumber: '123',
      postalCode: '94105',
    },
  ],
  isEmailVerified: false,
  stores: [],
  authenticationMode: 'Password',
  custom: {
    type: {
      typeId: 'type',
      id: 'mock-type-id',
    },
    fields: {
      stripeConnector_stripeCustomerId: 'cus_Example',
    },
  },
};

export const mockCtCustomerData_withoutType: Customer = {
  id: mockCtCustomerId,
  version: 1,
  createdAt: '2025-03-19T00:09:28.752Z',
  lastModifiedAt: '2025-03-19T00:48:46.632Z',
  email: 'test@example.com',
  firstName: 'Gildardo',
  lastName: 'Diaz',
  addresses: [
    {
      id: 'xxxxxx-test-id',
      country: 'US',
      city: 'San Francisco',
      state: 'CA',
      streetName: 'Main St',
      streetNumber: '123',
      postalCode: '94105',
    },
  ],
  isEmailVerified: false,
  stores: [],
  authenticationMode: 'Password',
};

export const mockCtCustomerWithoutCustomFieldsData: Customer = {
  id: mockCtCustomerId,
  version: 1,
  createdAt: '2025-03-19T00:09:28.752Z',
  lastModifiedAt: '2025-03-19T00:48:46.632Z',
  email: 'test@example.com',
  firstName: 'Gildardo',
  lastName: 'Diaz',
  addresses: [
    {
      id: 'xxxxxx-test-id',
      country: 'US',
      city: 'San Francisco',
      state: 'CA',
      streetName: 'Main St',
      streetNumber: '123',
      postalCode: '94105',
    },
  ],
  isEmailVerified: false,
  stores: [],
  authenticationMode: 'Password',
  custom: {
    type: {
      typeId: 'type',
      id: 'mock-type-id',
    },
    fields: {},
  },
};

export const mockSearchCustomerResponse: Stripe.Response<Stripe.ApiSearchResult<Stripe.Customer>> = {
  data: [mockCustomerData],
  has_more: false,
  lastResponse,
  next_page: null,
  object: 'search_result',
  url: '/customers',
};
