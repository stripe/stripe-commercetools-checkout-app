import { config } from '../config';
import { createOwnSubscription, deleteOwnSubscription } from './subscription';
import { log } from '../logger';

/**
 * Registers this deployment's `OrderCreated` subscription.
 *
 * The topic name and project id are injected by commercetools Connect for an `applicationType: event`
 * app. If they are absent the app is running somewhere that has not provisioned a topic — locally
 * without a `.env`, most likely — and creating a subscription without a destination is not possible.
 * Failing loudly beats creating something half-wired.
 */
const run = async (): Promise<void> => {
  const { gcpTopicName, gcpProjectId } = config;

  if (!gcpTopicName || !gcpProjectId) {
    throw new Error(
      'CONNECT_GCP_TOPIC_NAME and CONNECT_GCP_PROJECT_ID are required. commercetools Connect injects ' +
        'them for an applicationType: event app; set them in .env for local runs.',
    );
  }

  await deleteOwnSubscription(gcpTopicName);
  await createOwnSubscription(gcpTopicName, gcpProjectId);
};

run().catch((err) => {
  const e = err as Error;
  process.stderr.write(`Post-deploy failed: ${e.message}\n`);
  process.exitCode = 1;
});
