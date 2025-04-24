import {
  CustomFields,
  Type,
  TypeAddFieldDefinitionAction,
  TypeDraft,
  TypeRemoveFieldDefinitionAction,
  TypeUpdateAction,
} from '@commercetools/platform-sdk/dist/declarations/src/generated/models/type';
import {
  Customer,
  CustomerSetCustomFieldAction,
  CustomerSetCustomTypeAction,
  CustomerUpdateAction,
} from '@commercetools/platform-sdk/dist/declarations/src/generated/models/customer';
import { paymentSDK } from '../payment-sdk';
import { log } from '../libs/logger';

export interface KeyAndVersion {
  key: string;
  version: number;
}

const apiClient = paymentSDK.ctAPI.client;

export async function getTypeByKey(key: string): Promise<Type | undefined> {
  const res = await apiClient
    .types()
    .get({ queryArgs: { where: `key="${key}"` } })
    .execute();
  return res.body.results[0] || undefined;
}

export async function getTypesByResourceTypeId(resourceTypeId: string) {
  const res = await apiClient
    .types()
    .get({
      queryArgs: {
        where: `resourceTypeIds contains any ("${resourceTypeId}")`,
      },
    })
    .execute();
  return res.body.results;
}

export function hasField(type: Type, fieldName: string): boolean {
  return type.fieldDefinitions.some((field) => field.name === fieldName);
}

export function hasAllFields(customType: TypeDraft, type: Type) {
  return customType.fieldDefinitions?.every(({ name }) => hasField(type, name));
}

export function findValidCustomType(types: Type[], customType: TypeDraft) {
  for (const type of types) {
    const match = hasAllFields(customType, type);
    if (match) {
      return type;
    }
  }
  return undefined;
}

export async function updateCustomerById({
  id,
  version,
  actions,
}: {
  id: string;
  version: number;
  actions: CustomerUpdateAction[];
}): Promise<Customer> {
  const response = await apiClient.customers().withId({ ID: id }).post({ body: { version, actions } }).execute();
  return response.body;
}

export async function createCustomType(customType: TypeDraft): Promise<string> {
  const res = await apiClient.types().post({ body: customType }).execute();
  return res.body.id;
}

export async function updateCustomTypeByKey({
  key,
  version,
  actions,
}: KeyAndVersion & { actions: TypeUpdateAction[] }) {
  await apiClient.types().withKey({ key }).post({ body: { version, actions } }).execute();
}

export async function deleteCustomTypeByKey({ key, version }: KeyAndVersion): Promise<void> {
  await apiClient
    .types()
    .withKey({ key })
    .delete({
      queryArgs: { version },
    })
    .execute();
}

export async function addOrUpdateCustomType(customType: TypeDraft): Promise<void> {
  const resourceTypeId = customType.resourceTypeIds[0];
  const types = await getTypesByResourceTypeId(resourceTypeId);

  if (!types.length) {
    await createCustomType(customType);
    log.info(`Custom Type "${customType.key}" created successfully.`);
    return;
  }

  log.info(`Custom Type with resourceTypeId "${resourceTypeId}" already exists. Skipping creation.`);
  for (const type of types) {
    const { key, version } = type;
    const fieldUpdates: TypeAddFieldDefinitionAction[] = (customType.fieldDefinitions ?? [])
      .filter(({ name }) => !hasField(type, name))
      .map((fieldDefinition) => ({
        action: 'addFieldDefinition',
        fieldDefinition,
      }));

    if (!fieldUpdates.length) {
      log.info(`Custom Type "${key}" already contains all required fields. Skipping update.`);
      continue;
    }

    await updateCustomTypeByKey({ key, version, actions: fieldUpdates });
    log.info(`Custom Type "${key}" updated successfully with new fields.`);
  }
}

export async function deleteOrUpdateCustomType(customType: TypeDraft): Promise<void> {
  const resourceTypeId = customType.resourceTypeIds[0];
  const types = await getTypesByResourceTypeId(resourceTypeId);

  for (const type of types) {
    const { key, version } = type;
    const fieldUpdates: TypeRemoveFieldDefinitionAction[] = (customType.fieldDefinitions ?? [])
      .filter(({ name }) => hasField(type, name))
      .map(({ name }) => ({
        action: 'removeFieldDefinition',
        fieldName: name,
      }));

    if (!fieldUpdates.length) {
      log.info(`Custom Type "${key}" has no matching fields to remove. Skipping deletion.`);
      continue;
    }

    const hasSameFields = fieldUpdates.length === type.fieldDefinitions?.length;
    if (!hasSameFields) {
      await updateCustomTypeByKey({ key, version, actions: fieldUpdates });
      log.info(`Removed ${fieldUpdates.length} fields(s) from Custom Type "${key}" successfully.`);
      continue;
    }

    try {
      await deleteCustomTypeByKey({ key, version });
      log.info(`Custom Type "${key}" deleted successfully.`);
    } catch (error) {
      const referencedMessage = 'Can not delete a type while it is referenced';
      if (error instanceof Error && error.message.includes(referencedMessage)) {
        log.warn(`Custom Type "${key}" is referenced by at least one customer. Skipping deletion.`);
      } else {
        throw error;
      }
    }
  }
}

/**
 * This function is used to get the actions for setting a custom field in a customer.
 * If the custom type exists and all fields exist, it returns `setCustomField` actions,
 * if not, it returns `setCustomType` action.
 * @returns An array of actions to update the custom field in the customer.
 */
export async function getCustomFieldUpdateActions({
  resource,
  fields,
  customType,
}: {
  resource: { id: string; version: number; custom?: CustomFields };
  fields: Record<string, string>;
  customType: TypeDraft;
}): Promise<(CustomerSetCustomTypeAction | CustomerSetCustomFieldAction)[]> {
  const resourceTypeId = customType.resourceTypeIds[0];
  const allTypes = await getTypesByResourceTypeId(resourceTypeId);
  if (!allTypes.length) {
    throw new Error(`Custom Type not found for resource "${resourceTypeId.toUpperCase()}"`);
  }

  const typeAssigned = allTypes.find(({ id }) => id === resource.custom?.type.id);
  const allFieldsExist = !!(typeAssigned && hasAllFields(customType, typeAssigned));

  if (resource.custom?.type.id && allFieldsExist) {
    return Object.entries(fields).map(([name, value]) => ({
      action: 'setCustomField',
      name,
      value,
    }));
  }

  const newType = allTypes.find(({ key }) => key === customType.key) ?? findValidCustomType(allTypes, customType);
  if (!newType) {
    throw new Error(`A valid Custom Type was not found for resource "${resourceTypeId.toUpperCase()}"`);
  }

  return [
    {
      action: 'setCustomType',
      type: { key: newType.key, typeId: 'type' },
      fields,
    },
  ];
}
