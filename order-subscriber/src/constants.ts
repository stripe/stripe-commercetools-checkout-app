/**
 * The commercetools message this app subscribes to.
 *
 * `OrderCreated` is the whole point of this module. Verified 2026-08-19 against two real orders that
 * commercetools Checkout created: the message exists and is emitted 17–19 ms after the order itself.
 * That is what makes this trigger correct where the Stripe webhook path is not — `requires_action`
 * fires BEFORE the order exists, by construction, so no amount of retrying inside the webhook handler
 * can win. See `context/business-rules/order-payment-state.md` Rule 4.
 */
export const MESSAGE_TYPES = ['OrderCreated'] as const;

/**
 * commercetools sends a test message when a Subscription is created, and it is NOT an order message:
 * it arrives with `notificationType: 'ResourceCreated'`. Without discarding it explicitly the first
 * post-deploy processes a payload that has no order in it. The tax connector's order-syncer hits the
 * same thing and guards it the same way.
 */
export const NOTIFICATION_TYPE_RESOURCE_CREATED = 'ResourceCreated';

/**
 * Only orders paid through THIS connector are touched.
 *
 * `OrderCreated` is delivered for every order in the commercetools project — composable's orders,
 * other connectors' orders, orders created by hand in Merchant Center. Without this filter the
 * checkout subscriber would stamp `Pending` on orders it has no business touching, and in a project
 * shared between staging and every developer's slot that is not a hypothetical.
 *
 * `paymentInterface` is the authoritative discriminator because it is OUR data, written by this
 * connector when it creates the payment. The sibling connector writes `'stripe'`, so the two are
 * distinguishable. This is the same field that made it possible to attribute measurements during the
 * 2026-08-18/19 investigation, where neither the Stripe account nor commercetools'
 * `lastModifiedBy` could (all four deployments share one CT API client).
 */
export const PAYMENT_INTERFACE = 'checkout-stripe';

/**
 * Base for the commercetools Subscription key. NEVER used on its own — see `buildSubscriptionKey`.
 *
 * Deliberately different from the tax connector's `ct-connect-tax-integration-order-change-subscription`.
 * Two different connectors sharing one key would delete each other's subscription on every deploy.
 */
export const SUBSCRIPTION_KEY_BASE = 'ct-connect-stripe-checkout-order-subscription';

/** commercetools keys accept 2–256 chars of `[A-Za-z0-9_-]` only. */
const CT_KEY_ALLOWED = /[^A-Za-z0-9_-]/g;
const CT_KEY_MAX = 256;

/**
 * Builds a Subscription key that is unique PER DEPLOYMENT, not just per connector.
 *
 * WHY THIS IS NOT A CONSTANT, which is the trap the tax connector left behind. Its post-deploy runs
 * `deleteChangedOrderSubscription()` before creating, against a hardcoded key. That is fine while one
 * deployment exists. With staging plus a personal slot per developer — all in the same commercetools
 * project, which is how this project is actually set up — **every post-deploy deletes the other
 * deployments' subscription.** The last one to deploy wins and everyone else silently stops receiving
 * `OrderCreated`. Silently, because nothing errors: the subscription is simply gone.
 *
 * The topic name is the uniqueness source because commercetools Connect provisions one topic per
 * deployment and injects it as `CONNECT_GCP_TOPIC_NAME`. So it is exactly as unique as the thing we
 * need to distinguish, with no extra configuration for the merchant to get wrong.
 *
 * ASSUMPTION WORTH VERIFYING AT DEPLOY TIME: that the topic name is STABLE across redeploys of the
 * same deployment. If commercetools ever re-provisions a new topic on redeploy, the key changes with
 * it, `preUndeploy` deletes the old key and the new `postDeploy` creates a different one — which is
 * still correct, but a crash between the two would leak an orphan subscription pointing at a dead
 * topic. Check the topic name across two redeploys of the same slot before trusting this.
 */
export const buildSubscriptionKey = (topicName: string): string => {
  const suffix = topicName.replace(CT_KEY_ALLOWED, '-');
  return `${SUBSCRIPTION_KEY_BASE}-${suffix}`.slice(0, CT_KEY_MAX);
};
