import { Cart, LineItem, CustomLineItem, ShippingInfo } from '@commercetools/connect-payments-sdk';
import { randomUUID } from 'crypto';
import { mockCtCustomerId } from './mock-customer-data';

export const mockGetCartResult = () => {
  const cartId = randomUUID();
  const mockGetCartResult: Cart = {
    id: cartId,
    customerId: mockCtCustomerId,
    version: 1,
    lineItems: [lineItem],
    customLineItems: [customLineItem],
    totalPrice: {
      type: 'centPrecision',
      currencyCode: 'USD',
      centAmount: 150000,
      fractionDigits: 2,
    },
    cartState: 'Ordered',
    origin: 'Customer',
    taxMode: 'ExternalAmount',
    taxRoundingMode: 'HalfEven',
    taxCalculationMode: 'LineItemLevel',
    shipping: [],
    discountCodes: [],
    directDiscounts: [],
    refusedGifts: [],
    itemShippingAddresses: [],
    inventoryMode: 'ReserveOnOrder',
    shippingMode: 'Single',
    shippingInfo: shippingInfo,
    createdAt: '2024-01-01T00:00:00Z',
    lastModifiedAt: '2024-01-01T00:00:00Z',
    customerEmail: 'test@example.com',
    paymentInfo: {
      payments: [
        {
          id: 'paymentId',
          typeId: 'payment',
          obj: undefined,
        },
      ],
    },
    shippingAddress: {
      title: 'Mr.',
      firstName: 'John',
      lastName: 'Smith',
      streetName: 'Test street',
      streetNumber: '123',
      postalCode: '12345',
      city: 'Los Angeles',
      state: 'CA',
      country: 'US',
      phone: '+312345678',
      mobile: '+312345679',
      email: 'test@example.com',
      key: 'address1',
    },
    priceRoundingMode: 'HalfUp',
  };
  return mockGetCartResult;
};

export const mockGetCartWithoutCustomerIdResult = () => {
  const cartId = randomUUID();
  const mockGetCartResult: Cart = {
    id: cartId,
    customerId: '',
    version: 1,
    lineItems: [lineItem],
    customLineItems: [customLineItem],
    totalPrice: {
      type: 'centPrecision',
      currencyCode: 'USD',
      centAmount: 150000,
      fractionDigits: 2,
    },
    cartState: 'Ordered',
    origin: 'Customer',
    taxMode: 'ExternalAmount',
    taxRoundingMode: 'HalfEven',
    taxCalculationMode: 'LineItemLevel',
    shipping: [],
    discountCodes: [],
    directDiscounts: [],
    refusedGifts: [],
    itemShippingAddresses: [],
    inventoryMode: 'ReserveOnOrder',
    shippingMode: 'Single',
    shippingInfo: shippingInfo,
    createdAt: '2024-01-01T00:00:00Z',
    lastModifiedAt: '2024-01-01T00:00:00Z',
    customerEmail: 'test@example.com',
    paymentInfo: {
      payments: [
        {
          id: 'paymentId',
          typeId: 'payment',
          obj: undefined,
        },
      ],
    },
    shippingAddress: {
      title: 'Mr.',
      firstName: 'John',
      lastName: 'Smith',
      streetName: 'Test street',
      streetNumber: '123',
      postalCode: '12345',
      city: 'Los Angeles',
      state: 'CA',
      country: 'US',
      phone: '+312345678',
      mobile: '+312345679',
      email: 'test@example.com',
      key: 'address1',
    },
    priceRoundingMode: 'HalfUp',
  };
  return mockGetCartResult;
};

const lineItem: LineItem = {
  id: 'lineitem-id-1',
  productId: 'product-id-1',
  name: {
    en: 'lineitem-name-1',
  },
  productType: {
    id: 'product-type-reference-1',
    typeId: 'product-type',
  },
  price: {
    id: 'price-id-1',
    value: {
      type: 'centPrecision',
      currencyCode: 'USD',
      centAmount: 150000,
      fractionDigits: 2,
    },
  },
  quantity: 1,
  totalPrice: {
    type: 'centPrecision',
    currencyCode: 'USD',
    centAmount: 150000,
    fractionDigits: 2,
  },
  discountedPricePerQuantity: [],
  taxedPricePortions: [],
  state: [],
  perMethodTaxRate: [],
  priceMode: 'Platform',
  lineItemMode: 'Standard',
  variant: {
    id: 1,
    sku: 'variant-sku-1',
  },
};

const customLineItem: CustomLineItem = {
  id: 'customLineItem-id-1',
  name: {
    en: 'customLineItem-name-1',
  },
  slug: '',
  money: {
    type: 'centPrecision',
    currencyCode: 'USD',
    centAmount: 150000,
    fractionDigits: 2,
  },
  quantity: 1,
  totalPrice: {
    type: 'centPrecision',
    currencyCode: 'USD',
    centAmount: 150000,
    fractionDigits: 2,
  },
  discountedPricePerQuantity: [],
  taxedPricePortions: [],
  state: [],
  perMethodTaxRate: [],
  priceMode: 'Platform',
};

export const mockGetCartWithCountry = (country: string): Cart => ({
  ...mockGetCartResult(),
  country,
  billingAddress: { country: 'US' }, // billingAddress.country must NOT be reached
  shippingAddress: { country: 'US' }, // shippingAddress.country must NOT be reached
});

export const mockGetCartWithBillingCountryOnly = (country: string): Cart => ({
  ...mockGetCartResult(),
  country: undefined,
  billingAddress: { country },
  shippingAddress: { country: 'US' }, // should NOT be reached
});

export const mockGetCartWithShippingCountryOnly = (country: string): Cart => ({
  ...mockGetCartResult(),
  country: undefined,
  billingAddress: undefined,
  shippingAddress: { country },
});

export const mockGetCartWithStoreKey = (storeKey: string): Cart => ({
  ...mockGetCartResult(),
  country: undefined,
  billingAddress: undefined,
  shippingAddress: undefined,
  store: { typeId: 'store', key: storeKey } as any,
});

const shippingInfo: ShippingInfo = {
  shippingMethodName: 'shippingMethodName1',
  price: {
    type: 'centPrecision',
    currencyCode: 'USD',
    centAmount: 150000,
    fractionDigits: 2,
  },
  shippingRate: {
    price: {
      type: 'centPrecision',
      currencyCode: 'USD',
      centAmount: 1000,
      fractionDigits: 2,
    },
    tiers: [],
  },
  shippingMethodState: 'MatchesCart',
};
