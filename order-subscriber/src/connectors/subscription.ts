import { apiRoot } from '../clients/ct.client';
import { buildSubscriptionKey, MESSAGE_TYPES } from '../constants';
import { log } from '../logger';

/**
 * Deletes the subscription for THIS deployment's key, if present.
 *
 * Scoped by the per-deployment key on purpose. The tax connector deletes a hardcoded key, which means
 * every deployment's post-deploy wipes the others' subscription — see `buildSubscriptionKey`. Deleting
 * only our own key is what makes several deployments coexist in one commercetools project.
 */
export const deleteOwnSubscription = async (topicName: string): Promise<void> => {
  const key = buildSubscriptionKey(topicName);
  try {
    const existing = await apiRoot.subscriptions().withKey({ key }).get().execute();
    await apiRoot
      .subscriptions()
      .withKey({ key })
      .delete({ queryArgs: { version: existing.body.version } })
      .execute();
    log.info('Deleted the existing subscription for this deployment', { key });
  } catch (err) {
    const e = err as Error & { statusCode?: number };
    if (e.statusCode === 404) {
      log.info('No existing subscription for this deployment — nothing to delete', { key });
      return;
    }
    throw err;
  }
};

export const createOwnSubscription = async (topicName: string, projectId: string): Promise<void> => {
  const key = buildSubscriptionKey(topicName);
  await apiRoot
    .subscriptions()
    .post({
      body: {
        key,
        destination: { type: 'GoogleCloudPubSub', topic: topicName, projectId },
        messages: [{ resourceTypeId: 'order', types: [...MESSAGE_TYPES] }],
      },
    })
    .execute();
  log.info('Subscription created', { key, topicName, projectId, messages: [...MESSAGE_TYPES] });
};
