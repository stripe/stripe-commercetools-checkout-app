import { paymentSDK } from '../payment-sdk';
import { StripePaymentService } from '../services/stripe-payment.service';

const paymentService = new StripePaymentService({
  ctCartService: paymentSDK.ctCartService,
  ctPaymentService: paymentSDK.ctPaymentService,
  ctOrderService: paymentSDK.ctOrderService,
  ctPaymentMethodService: paymentSDK.ctPaymentMethodService,
  ctRecurringPaymentJobService: (paymentSDK as any).ctRecurringPaymentJobService || {
    createRecurringPaymentJobIfApplicable: async () => null,
  },
});

export const app = {
  services: {
    paymentService,
  },
};
