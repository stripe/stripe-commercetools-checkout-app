let ckoCartId = null;

const getAuthHeaders = async () => {
  const token = await fetchAdminToken();
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  };
};

const getCart = async () => {
  const url = `${__VITE_CTP_API_URL__}/${__VITE_CTP_PROJECT_KEY__}/carts/${ckoCartId}`;
  const headers = await getAuthHeaders();
  const res = await fetch(url, {
    method: "GET",
    headers,
  });
  return await res.json();
};

/**
 * Returns current cart subtotal (line items only, no shipping) for Express Checkout amount updates.
 * Used so the displayed total reflects the actual cart when address or shipping method changes.
 */
const getCurrentCartSubtotal = async () => {
  const cart = await getCart();
  const totalCents = cart.totalPrice?.centAmount ?? 0;
  const shippingCents = cart.shippingInfo?.price?.centAmount ?? 0;
  return {
    centAmount: totalCents - shippingCents,
    currencyCode: cart.totalPrice?.currencyCode ?? "USD",
    fractionDigits: cart.totalPrice?.fractionDigits ?? 2,
  };
};

const getShippingMethods = async (opts) => {
  const url = `${__VITE_CTP_API_URL__}/${__VITE_CTP_PROJECT_KEY__}/shipping-methods/matching-cart?cartId=${ckoCartId}`;
  const headers = await getAuthHeaders();
  const res = await fetch(url, {
    method: "GET",
    headers,
  });
  const data = await res.json();

  if (!data.results || data.results.length === 0) {
    return [];
  }

  return data.results.map((method) => {
    const shippingMethod = {
      id: method.id,
      name: method.name,
      description: method?.localizedName?.[0] || "",
      isSelected: method.isDefault,
    };

    const zoneRates = method.zoneRates || [];
    const shippingRates = zoneRates[0]?.shippingRates || [];
    const zoneRate = shippingRates.find((rate) => rate.isMatching);

    if (zoneRate?.price) {
      shippingMethod.amount = {
        centAmount: zoneRate.price.centAmount,
        currencyCode: zoneRate.price.currencyCode,
        fractionDigits: zoneRate.price.fractionDigits,
      };
    }

    return shippingMethod;
  });
};

const setShippingMethod = async (opts) => {
  const url = `${__VITE_CTP_API_URL__}/${__VITE_CTP_PROJECT_KEY__}/carts/${ckoCartId}`;
  const cart = await getCart();
  const headers = await getAuthHeaders();

  const payload = {
    version: cart.version,
    actions: [
      {
        action: "setShippingMethod",
        shippingMethod: {
          id: opts.shippingMethod.id,
          typeId: "shipping-method",
        },
      },
    ],
  };

  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    throw new Error("unable to set shipping method");
  }

  return await res.json();
};

const mapAddressToCtp = (address) => ({
  country: address.country,
  postalCode: address.postalCode,
  city: address.city,
  firstName: address.firstName,
  lastName: address.lastName,
  streetName: address.streetName,
  streetNumber: address.streetNumber,
  additionalStreetInfo: address.additionalStreetInfo,
  region: address.region || address.state,
  phone: address.phone,
  email: address.email,
});

const setShippingAddress = async (opts) => {
  const url = `${__VITE_CTP_API_URL__}/${__VITE_CTP_PROJECT_KEY__}/carts/${ckoCartId}`;
  const cart = await getCart();
  const headers = await getAuthHeaders();

  const payload = {
    version: cart.version,
    actions: [
      {
        action: "setShippingAddress",
        address: mapAddressToCtp(opts.address),
      },
    ],
  };

  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    throw new Error("unable to set shipping address");
  }

  return await res.json();
};

const setBillingAddress = async (opts) => {
  const url = `${__VITE_CTP_API_URL__}/${__VITE_CTP_PROJECT_KEY__}/carts/${ckoCartId}`;
  const cart = await getCart();
  const headers = await getAuthHeaders();

  const payload = {
    version: cart.version,
    actions: [
      {
        action: "setBillingAddress",
        address: mapAddressToCtp(opts.address),
      },
    ],
  };

  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    throw new Error("unable to set billing address");
  }

  return await res.json();
};
