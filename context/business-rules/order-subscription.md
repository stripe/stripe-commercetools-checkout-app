# Order Subscription

How the order-subscriber registers for and acknowledges commercetools order messages. What it writes
when it acts is in `order-payment-state.md` Rules 6, 7 and 9.

## Rule 1: The Subscription key is unique per deployment

**What:** the Subscription key is the base `ct-connect-stripe-checkout-order-subscription` suffixed with
the deployment's Pub/Sub topic name, sanitised to `[A-Za-z0-9_-]` and cut to 256 characters.
**Why:** several deployments share one commercetools project, and Connect provisions one topic per
deployment, so the topic name is the uniqueness source.
**Invariant:** every create and delete uses `buildSubscriptionKey(topicName)`.
**Implementation:** `order-subscriber/src/constants.ts:47`, `:73-76`; `order-subscriber/src/connectors/subscription.ts:13`, `:33`

---

## Rule 2: Deploy and undeploy touch only this deployment's Subscription

**What:** post-deploy deletes then recreates the key for this topic; pre-undeploy deletes it; a 404 on
delete is not an error.
**Why:** undeploying one deployment must not stop another from receiving `OrderCreated`.
**Invariant:** `deleteOwnSubscription` deletes by `withKey({ key })` for the computed key only.
**Implementation:** `order-subscriber/src/connectors/subscription.ts:12-30`;
`order-subscriber/src/connectors/post-deploy.ts:23-24`; `order-subscriber/src/connectors/pre-undeploy.ts:8-14`

---

## Rule 3: Post-deploy refuses to run without a Connect-provided topic

**What:** post-deploy throws when `CONNECT_GCP_TOPIC_NAME` or `CONNECT_GCP_PROJECT_ID` is absent.
**Why:** a subscription without a destination cannot be created; failing loudly beats creating something
half-wired (`order-subscriber/src/connectors/post-deploy.ts:5-12`).
**Invariant:** no Subscription call is made when either value is empty.
**Implementation:** `order-subscriber/src/connectors/post-deploy.ts:16-21`

---

## Rule 4: Only order-creation messages are acted on

**What:** the subscription covers `OrderCreated` and `OrderCreatedFromRecurringOrder` on resource type
`order`; the subscription's own `ResourceCreated` test message and any other type are ignored.
**Why:** commercetools sends a test message on subscription creation that carries no order
(`order-subscriber/src/constants.ts:17-22`); a recurring cycle emits `OrderCreatedFromRecurringOrder`, not
`OrderCreated` (`:10-14`).
**Invariant:** `classify` returns `act: true` only for a listed type with `resource.typeId === 'order'` and
an id, and returns only the order id.
**Implementation:** `order-subscriber/src/constants.ts:15`; `order-subscriber/src/validators/message.validator.ts:20-41`;
`order-subscriber/src/connectors/subscription.ts:40`

---

## Rule 5: Ignored and undecodable messages are acknowledged; failed writes are retried

**What:** the handler answers 204 for a message it ignores, cannot decode, or handled, and 500 when the
write fails.
**Why:** Pub/Sub retries any non-2xx response (`order-subscriber/src/controllers/order.controller.ts:8-19`).
**Invariant:** every `return` in `orderCreatedHandler` is 204 except the `catch` of the write, which is 500.
**Implementation:** `order-subscriber/src/controllers/order.controller.ts:20-65`
