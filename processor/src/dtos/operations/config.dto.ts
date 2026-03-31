import { Static, Type } from '@sinclair/typebox';

/**
 * Public shareable payment provider configuration. Do not include any sensitive data.
 */
export const ConfigResponseSchema = Type.Object({
  environment: Type.String(),
  publishableKey: Type.String(),
  captureMethod: Type.Optional(
    Type.Union([
      Type.Literal('automatic'),
      Type.Literal('automatic_async'),
      Type.Literal('manual'),
    ]),
  ),
  appearance: Type.Optional(Type.String()),
});

export type ConfigResponseSchemaDTO = Static<typeof ConfigResponseSchema>;
