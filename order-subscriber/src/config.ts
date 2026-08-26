import 'dotenv/config';

/**
 * `CONNECT_GCP_TOPIC_NAME` and `CONNECT_GCP_PROJECT_ID` are injected by commercetools Connect for an
 * `applicationType: event` app. They are deliberately NOT declared in connect.yaml's `configuration`
 * block — the merchant never supplies them, and hardcoding topic names in the deployment YAML is
 * exactly what we were told not to do. Locally they come from `.env`.
 */
export const config = {
  projectKey: required('CTP_PROJECT_KEY'),
  clientId: required('CTP_CLIENT_ID'),
  clientSecret: required('CTP_CLIENT_SECRET'),
  authUrl: required('CTP_AUTH_URL'),
  apiUrl: required('CTP_API_URL'),
  gcpTopicName: process.env.CONNECT_GCP_TOPIC_NAME ?? '',
  gcpProjectId: process.env.CONNECT_GCP_PROJECT_ID ?? '',
  port: Number(process.env.PORT ?? 8080),
};

function required(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Missing required environment variable ${key}`);
  return value;
}
