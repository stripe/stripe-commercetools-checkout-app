# Deploy and Undeploy the Connector

**Trigger:** commercetools Connect runs `postDeploy` / `preUndeploy` for the `processor` and `order-subscriber` applications (`connect.yaml:7-9,36-38`).
**Modules involved:** processor, order-subscriber.
**Outcome:** on deploy, the Stripe webhook endpoint pointed at the service, the customer custom type present, and this deployment's `OrderCreated` subscription registered; on undeploy, the reverse.

## Happy Path

1. Processor post-deploy: read the launchpad purchase-order type — `processor/src/connectors/post-deploy.ts:17`; `processor/src/connectors/actions.ts:41-46`
2. If `STRIPE_WEBHOOK_ID` is set: retrieve the endpoint and, **only if its URL differs** from `{CONNECT_SERVICE_URL}stripe/webhooks`, update the URL and the 12 enabled events — `processor/src/connectors/post-deploy.ts:19-33`; `processor/src/connectors/actions.ts:48-92`
3. Create or update the customer custom type — `processor/src/connectors/post-deploy.ts:36`; `processor/src/connectors/actions.ts:94-100`
4. order-subscriber post-deploy: require the Connect topic and project id, delete then create **its own** Subscription (per-deployment key) for `OrderCreated` and `OrderCreatedFromRecurringOrder` — `order-subscriber/src/connectors/post-deploy.ts:13-25`; `order-subscriber/src/connectors/subscription.ts:12-45`
5. Undeploy: processor removes the subscription product type, line-item type and customer type; order-subscriber deletes only its own Subscription — `processor/src/connectors/pre-undeploy.ts:6-10`; `order-subscriber/src/connectors/pre-undeploy.ts:8-14`

## Error Paths

| Condition | Behavior | File |
| --- | --- | --- |
| `STRIPE_WEBHOOK_ID` unset | endpoint not updated — add the URL manually | `processor/src/connectors/post-deploy.ts:23-26` |
| Topic or project id missing | throws, exit 1 | `order-subscriber/src/connectors/post-deploy.ts:16-21,27-31` |
| Subscription API error (other than 404 on delete) | stderr, exit 1 | `order-subscriber/src/connectors/subscription.ts:22-29`; `order-subscriber/src/connectors/post-deploy.ts:27-31` |
| Undeploy without a topic name | "nothing to clean up", exit 0 | `order-subscriber/src/connectors/pre-undeploy.ts:9-12` |

## Notes

- Rules: `business-rules/order-subscription.md` — Rule 1 "The Subscription key is unique per deployment", Rule 2 "Deploy and undeploy touch only this deployment's Subscription", Rule 3 "Post-deploy refuses to run without a Connect-provided topic".
