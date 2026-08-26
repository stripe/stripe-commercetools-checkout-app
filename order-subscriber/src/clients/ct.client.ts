import { ClientBuilder } from '@commercetools/ts-client';
import { createApiBuilderFromCtpClient } from '@commercetools/platform-sdk';
import { config } from '../config';

const client = new ClientBuilder()
  .withClientCredentialsFlow({
    host: config.authUrl,
    projectKey: config.projectKey,
    credentials: { clientId: config.clientId, clientSecret: config.clientSecret },
  })
  .withHttpMiddleware({ host: config.apiUrl })
  .build();

export const apiRoot = createApiBuilderFromCtpClient(client).withProjectKey({ projectKey: config.projectKey });
