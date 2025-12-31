import Stripe from 'stripe';
import { getConfig } from '../config/config';
import { StripeApiError, StripeApiErrorData } from '../errors/stripe-api.error';
import { log } from '../libs/logger';

export type StripeRegion = 'US' | 'CA' | 'EU';
 
export const stripeApi = (region: StripeRegion): Stripe => {
  const properties = new Map(Object.entries(process.env));
  const appInfoUrl = properties.get('CONNECT_SERVICE_URL') ?? 'https://example.com';
 
  const config = getConfig();
 
  const secretKey =
    region === 'US'
      ? config.stripeSecretKeyUS
      : region === 'CA'
      ? config.stripeSecretKeyCA
      : config.stripeSecretKeyEU;
 
  return new Stripe(secretKey, {
    appInfo: {
      name: 'Stripe app for Commercetools Connect',
      version: '1.0.00',
      url: appInfoUrl,
      partner_id: 'pp_partner_c0mmercet00lsc0NNect',
    },
  });
};

export const wrapStripeError = (e: any): Error => {
  if (e?.raw) {
    const errorData = JSON.parse(JSON.stringify(e.raw)) as StripeApiErrorData;
    return new StripeApiError(errorData, { cause: e });
  }

  log.error('Unexpected error calling Stripe API:', e);
  return e;
};
