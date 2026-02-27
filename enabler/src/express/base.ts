import {
  ExpressAddressData,
  ExpressComponent,
  ExpressOptions,
  ExpressShippingOptionData,
} from '../payment-enabler/payment-enabler';

/**
 * Base class for express checkout components (template pattern).
 * Centralizes delegation to ExpressOptions callbacks.
 */
export abstract class DefaultExpressComponent implements ExpressComponent {
  protected expressOptions: ExpressOptions;

  constructor(opts: { expressOptions: ExpressOptions }) {
    this.expressOptions = opts.expressOptions;
  }

  abstract init(): void | Promise<void>;
  abstract mount(selector: string): void | Promise<void>;

  async setShippingAddress(opts: { address: ExpressAddressData }): Promise<void> {
    if (this.expressOptions.onShippingAddressSelected) {
      await this.expressOptions.onShippingAddressSelected(opts);
      return;
    }
    throw new Error('setShippingAddress not implemented');
  }

  async getShippingMethods(opts: {
    address: ExpressAddressData;
  }): Promise<ExpressShippingOptionData[]> {
    if (this.expressOptions.getShippingMethods) {
      return await this.expressOptions.getShippingMethods(opts);
    }
    throw new Error('getShippingMethods not implemented');
  }

  async setShippingMethod(opts: {
    shippingMethod: { id: string };
  }): Promise<void> {
    if (this.expressOptions.onShippingMethodSelected) {
      await this.expressOptions.onShippingMethodSelected(opts);
      return;
    }
    throw new Error('setShippingMethod not implemented');
  }
}
