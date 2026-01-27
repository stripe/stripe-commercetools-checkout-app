import Stripe from 'stripe';
import { getConfig } from '../config/config';
import { StripeApiError, StripeApiErrorData } from '../errors/stripe-api.error';
import { log } from '../libs/logger';
 
/**
* Resolve Stripe Secret Key based on commercetools project region.
* Assumes project keys contain region identifiers like: us / ca / eu
*/
function getStripeSecretKeyByRegion(): string {
  const projectKey = getConfig().projectKey.toLowerCase();
 
  if (projectKey.includes('eu')) {
    return process.env.STRIPE_SECRET_KEY_EU!;
  }
 
  if (projectKey.includes('ca')) {
    return process.env.STRIPE_SECRET_KEY_CA!;
  }
 
  // Default → US
  return process.env.STRIPE_SECRET_KEY_US!;
}
 
/**
* Stripe API client factory
*/
export const stripeApi = (): Stripe => {
  const properties = new Map(Object.entries(process.env));
  const appInfoUrl = properties.get('CONNECT_SERVICE_URL') ?? 'https://example.com';
 
  return new Stripe(getStripeSecretKeyByRegion(), {
    appInfo: {
      name: 'Stripe app for Commercetools Connect',
      version: '1.0.00',
      url: appInfoUrl,
      partner_id: 'pp_partner_c0mmercet00lsc0NNect', // Stripe partner identifier
    },
    //apiVersion: getConfig().stripeApiVersion as Stripe.LatestApiVersion,
  });
};
 
/**
* Normalize Stripe API errors into connector-friendly errors
*/
export const wrapStripeError = (e: any): Error => {
  if (e?.raw) {
    const errorData = JSON.parse(JSON.stringify(e.raw)) as StripeApiErrorData;
    return new StripeApiError(errorData, { cause: e });
  }
 
  log.error('Unexpected error calling Stripe API:', e);
  return e;
};
