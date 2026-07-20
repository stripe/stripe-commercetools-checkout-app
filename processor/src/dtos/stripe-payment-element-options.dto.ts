import { Static, Type } from '@sinclair/typebox';

/**
 * Mirrors @stripe/stripe-js's StripePaymentElementOptions (elements.create('payment', options)).
 * Shapes verified against enabler/node_modules/@stripe/stripe-js/dist/stripe-js/elements/payment.d.ts —
 * `terms` and `wallets` are closed sets defined by the SDK itself, not merchant-configurable key lists.
 * `paymentMethodTypes` is intentionally not included — conflicts with the connector's own PM configuration.
 */

const TermOption = Type.Union([Type.Literal('auto'), Type.Literal('always'), Type.Literal('never')]);
const PaymentWalletOption = Type.Union([Type.Literal('auto'), Type.Literal('never')]);
const FieldOption = Type.Union([Type.Literal('auto'), Type.Literal('never')]);
const FieldAddressOption = Type.Union([Type.Literal('auto'), Type.Literal('never'), Type.Literal('if_required')]);
const Layout = Type.Union([Type.Literal('tabs'), Type.Literal('accordion'), Type.Literal('auto')]);

export const TermsOptionSchema = Type.Object({
  applePay: Type.Optional(TermOption),
  auBecsDebit: Type.Optional(TermOption),
  bancontact: Type.Optional(TermOption),
  card: Type.Optional(TermOption),
  cashapp: Type.Optional(TermOption),
  googlePay: Type.Optional(TermOption),
  ideal: Type.Optional(TermOption),
  paypal: Type.Optional(TermOption),
  sepaDebit: Type.Optional(TermOption),
  sofort: Type.Optional(TermOption),
  usBankAccount: Type.Optional(TermOption),
});

export const PaymentWalletsOptionSchema = Type.Object({
  applePay: Type.Optional(PaymentWalletOption),
  googlePay: Type.Optional(PaymentWalletOption),
});

export const DefaultValuesOptionSchema = Type.Object({
  billingDetails: Type.Optional(
    Type.Object({
      name: Type.Optional(Type.String()),
      email: Type.Optional(Type.String()),
      phone: Type.Optional(Type.String()),
      address: Type.Optional(
        Type.Object({
          country: Type.Optional(Type.String()),
          postal_code: Type.Optional(Type.String()),
          state: Type.Optional(Type.String()),
          city: Type.Optional(Type.String()),
          line1: Type.Optional(Type.String()),
          line2: Type.Optional(Type.String()),
        }),
      ),
    }),
  ),
});

const FieldsAddressGranularSchema = Type.Object({
  country: Type.Optional(FieldOption),
  postalCode: Type.Optional(FieldOption),
  state: Type.Optional(FieldOption),
  city: Type.Optional(FieldOption),
  line1: Type.Optional(FieldOption),
  line2: Type.Optional(FieldOption),
});

export const FieldsOptionSchema = Type.Object({
  billingDetails: Type.Optional(
    Type.Union([
      FieldOption,
      Type.Object({
        name: Type.Optional(FieldOption),
        email: Type.Optional(FieldOption),
        phone: Type.Optional(FieldOption),
        address: Type.Optional(Type.Union([FieldAddressOption, FieldsAddressGranularSchema])),
      }),
    ]),
  ),
});

export const LayoutObjectSchema = Type.Object({
  type: Layout,
  defaultCollapsed: Type.Optional(Type.Boolean()),
  radios: Type.Optional(Type.Boolean()),
  spacedAccordionItems: Type.Optional(Type.Boolean()),
  visibleAccordionItemsCount: Type.Optional(Type.Number()),
});

export const PaymentElementBehaviorOptionsSchema = Type.Object({
  terms: Type.Optional(TermsOptionSchema),
  wallets: Type.Optional(PaymentWalletsOptionSchema),
  defaultValues: Type.Optional(DefaultValuesOptionSchema),
  fields: Type.Optional(FieldsOptionSchema),
  business: Type.Optional(Type.Object({ name: Type.String() })),
  paymentMethodOrder: Type.Optional(Type.Array(Type.String())),
  readOnly: Type.Optional(Type.Boolean()),
  layout: Type.Optional(Type.Union([Layout, LayoutObjectSchema])),
});

export type PaymentElementBehaviorOptionsDTO = Static<typeof PaymentElementBehaviorOptionsSchema>;
