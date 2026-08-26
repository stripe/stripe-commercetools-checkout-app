import { config } from '../config';
import { deleteOwnSubscription } from './subscription';

/**
 * Removes only THIS deployment's subscription, leaving every other deployment's intact. Undeploying a
 * personal slot must not stop staging from receiving `OrderCreated`.
 */
const run = async (): Promise<void> => {
  if (!config.gcpTopicName) {
    process.stderr.write('No CONNECT_GCP_TOPIC_NAME — nothing to clean up.\n');
    return;
  }
  await deleteOwnSubscription(config.gcpTopicName);
};

run().catch((err) => {
  const e = err as Error;
  process.stderr.write(`Pre-undeploy failed: ${e.message}\n`);
  process.exitCode = 1;
});
