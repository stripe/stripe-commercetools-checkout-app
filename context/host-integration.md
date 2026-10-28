# ct-connect-stripe-checkout — Host Integration

> Who this is for: developers of an application that embeds this connector's payment component
> (a storefront, or commercetools Checkout configured by you) and therefore has to create carts,
> sessions and orders around it.
> To install and run the connector itself, see `adopter-guide.md`.

**Code this describes.** If this context is consumed as a published edition, its stamp states which
commit it describes; this document does not repeat it. Whether a given deployment runs that code is answered in §2.3, not assumed.

**How claims are marked.** `file:line` is a fact read in this repository. `external — …; confirmed
2026-10, <source>` is a fact about commercetools or Stripe taken from their public documentation on
that date; it is not visible in this code and can expire. Anything that could not be sourced is in §7.

---

## 1. Integration paths

| Path | How the host reaches the unit | Caller | Status | Source |
| --- | --- | --- | --- | --- |
| **A. commercetools Checkout, Complete Checkout** | Host backend creates a Checkout Session with the Application's `applicationKey` (§3.2); host browser calls the Checkout Browser SDK `checkoutFlow` (§4.10); Checkout loads the enabler, runs every step and creates the order (§5.5) | platform — Checkout's copy of the enabler calls the processor; your backend calls only commercetools, your browser only the Checkout SDK | supported | **Basis:** commercetools' documentation — `external` — `checkoutFlow` "initialize[s] the full checkout process"; confirmed 2026-10, https://docs.commercetools.com/checkout/browser-sdk. Checkout's order timing was measured against `order-subscriber/src/guard.ts:135-142`. The connector's own `README.md:146-150` (select it as the drop-in payment method in Checkout) is a source for the setup, not for the status |
| **B. commercetools Checkout, Payment Only** | Host runs its own address/shipping steps, then calls `paymentFlow` with a Checkout Session of a *Payment Only* Application; Checkout renders the payment step, creates the Payment and the Order | platform — as A | supported | **Basis: platform documentation only.** `external` — Payment Only mode "communicates with PSPs (to process the payment) and the Carts and Orders API (to create the Order)"; confirmed 2026-10, https://docs.commercetools.com/checkout/overview. This repository never mentions Payment Only, nothing in the code is specific to it, and no observation with this connector is recorded (§7) |
| **C. commercetools Checkout Express** | Host calls `expressPayment.init()` once, then `expressPayment.mount()` (or `getAvailableMethods()` + `mountMethod()`) per placement (§4.11); Checkout drives the enabler's Express builder and creates the order | platform — as A; your Express callbacks, if you pass any, are invoked by Checkout (§4.11) | supported | **Basis: platform documentation.** `external` — two-step "Initialize once … Mount multiple times"; `express_payment_completed` carries `order.id`; confirmed 2026-10, https://docs.commercetools.com/checkout/browser-sdk. Corroborating, not a basis: `enabler/src/payment-enabler/payment-enabler.ts:415-418` ("Shaped for commercetools Checkout Express integration"); `enabler/README.md:39`. No observation of Express through Checkout is recorded |
| **D. Direct: host constructs the enabler, drop-in** | Host loads `connector-enabler.{es,umd}.js` from the deployment, creates a session itself, calls `new Enabler({...})` → `createDropinBuilder('embedded')` → `build()` → `mount()` → `submit()` | host browser (the enabler, from your page, calls the processor); your backend creates the session with commercetools | supported | **Basis: platform documentation of the template, not of this connector.** `external` — the payment-integration template's enabler is "suitable for direct integration in custom frontend applications"; confirmed 2026-10, https://docs.commercetools.com/connect/templates/payment-integration. This connector is laid out as that template is — an `enabler` assets application and a `processor` service (`connect.yaml:2-3`, `:33-35`) — but no direct host is recorded as observed. Corroborating, not a basis: `enabler/README.md:4` ("In cases connector is used directly and not through Checkout product, this connector UI can be loaded directly on frontend"). Reference implementation: `enabler/index.html:501-824` |
| **E. Direct: Express with a session** | As D, then `createExpressBuilder('dropin')` → `build(ExpressOptions)` → `mount()` | host browser | unknown | **Only this repository's own documentation claims it:** `enabler/README.md:41`, `:45-55`; dev page `enabler/index.html:694-766`. The platform text cited for D does not mention Express, and the Express options are "shaped for commercetools Checkout" (`payment-enabler.ts:415-418`). The code implements it; nothing outside the repository says it is a supported use (§7) |
| **F. Direct: Express before a session exists** (e.g. product page) | `new Enabler({ processorUrl })` with no `sessionId`; the enabler calls `POST /express-config`; the host creates cart and session inside `onPayButtonClick` | host browser — the only path where an unauthenticated browser call reaches the processor | unknown | **Only this repository's own documentation claims it:** `enabler/README.md:41`. Implemented at `enabler/src/payment-enabler/payment-enabler-mock.ts:236-238`, `:311-355`; nothing outside the repository says it is a supported use (§7) |
| **G1. Host browser calls the processor's HTTP endpoints without the enabler** (own Stripe.js code) | `x-session-id` requests to `/config-element/payment`, `/payments`, `/confirmPayments/:id` from your page | host browser | works-unsupported | The session routes answer any origin (`processor/src/server/server.ts:40-43`, `origin: '*'`). They are documented in `processor/README.md:181-452`, but as called "from Checkout UI" (`processor/README.md:2`). Nothing states a contract for other callers, and Stripe Elements must be initialised with values that match the PaymentIntent the processor creates (capture method, `setup_future_usage`, amount) — §3.15 lists what the enabler does with Stripe.js that you would then have to do |
| **G2. Host backend calls the processor's session endpoints** | The same `x-session-id` requests server-side: reading `/config-element/payment` or `/operations/config` (§2.4), or `POST /confirmPayments/:id` from a return-page handler (§5.4) | host backend | works-unsupported | Same basis as G1: the session hook does not distinguish callers (`processor/src/routes/stripe-payment.route.ts:51,77,99,397`; `processor/src/routes/operation.route.ts:38`), and no document states a contract for server-side callers |

**Not paths:** `createComponentBuilder(type)` throws for every type — its supported list is empty
(`enabler/src/payment-enabler/payment-enabler-mock.ts:194-209`). The `hpp` drop-in is commented out
(`…-mock.ts:218-221`). Express type is `dropin` only (`…-mock.ts:239-241`). The full list of what the
enabler accepts but never acts on is in §4.14.
For paths A–C this means: in the Checkout Application, add this connector as a **Standard Payments →
Drop-in** integration (and, for C, as **Express Payments** integrations), never as **Web components** —
the connector's own README says drop-in (`README.md:146`), and its component builder rejects every
type. (`external` — "Although you can configure both types, only one can be active at a time";
confirmed 2026-10, https://docs.commercetools.com/checkout/connectors-and-applications.)

**Which to choose.** If you run commercetools Checkout, use A, B or C: Checkout creates the session
metadata, loads the bundle, creates the order and handles the return from redirect methods, and the
connector's order-state logic was measured against Checkout's timing (`order-subscriber/src/guard.ts:135-142`).
If your storefront is the host (D–F), the payment component behaves the same, but **everything
Checkout would have done around it becomes yours**. Of the direct paths, only D (drop-in) rests on
platform documentation; E and F (Express without Checkout) are `unknown` — the code implements them
and the repository's README describes them, but a host built on them cannot point to any contract
outside this repository:

| Concern | With Checkout (A–C) | Direct host (D–F) |
| --- | --- | --- |
| What you configure first | A Checkout **Application** in Merchant Center (§2.5) | Nothing outside this connector |
| Session and its metadata | Your backend creates one **Checkout Session** with `metadata.applicationKey` (§3.2); Checkout creates the connector's payment sessions itself (`external` — "It creates payment sessions for all active payment methods…"; confirmed 2026-10, https://docs.commercetools.com/checkout/browser-sdk) | Your backend calls the Sessions API with `processorUrl` / `allowedPaymentMethods` metadata (§3.2) |
| What your browser code drives | The Checkout Browser SDK (§4.10–4.13) | The enabler (§4.1–4.9) |
| Loading the bundle | Checkout | You (§4.0) |
| Creating the Order | Checkout (§5.5) | You — the connector **never** creates orders (`processor/README.md:607-612`; `processor/src/services/stripe-payment.service.ts:2245-2251`) |
| `Order.paymentState` | Written by `order-subscriber` / processor on Checkout's timing (§5.5) | Depends on **when you create the order** — §5.3 |
| Return from redirect methods | Checkout SDK re-entered with `paymentReference` (§5.4) | Your return page (§5.4) |
| Error and pending screens | Checkout's success and error pages (A, B), plus Checkout Messages to your `onInfo`/`onError` (§4.12). Express (C) shows no error page — yours | Your UI, from `onComplete` / `onError` (§4.4, §4.7) |

---

## 2. Before the first call

| What the host needs | Where it comes from | Who creates it | Lifetime / scope |
| --- | --- | --- | --- |
| commercetools API client for the **host backend** | Merchant Center → API clients | operator | Scopes: `manage_sessions` to create sessions (`external` — "Grants permission to create a Checkout Session using the Session API"; confirmed 2026-10, https://docs.commercetools.com/checkout/scopes); `manage_orders` to create/update carts and orders and to change `paymentState` (`external` — "view, create, update, and delete Carts, Orders…"; confirmed 2026-10, https://docs.commercetools.com/api/scopes). For paths A–C commercetools states that one client with only `manage_orders` and `manage_sessions` is sufficient (`external`; confirmed 2026-10, https://docs.commercetools.com/checkout/installing-checkout); add `view_checkout_applications` only to read the Application by API (§2.5); `view_shipping_methods` if you list shipping methods for Express; `view_payments` if your backend reads the Payment to decide the outcome (§3.5). Store-scoped variants exist for orders (same source). **The connector's own client is a different client** with its own scopes (`connect.yaml:141-143`); do not reuse it |
| OAuth access token | `POST {authUrl}/oauth/token`, `grant_type=client_credentials` | host backend | Example: `enabler/dev-utils/session.js:3-27`. Never in the browser — the repository's dev page does that only for development |
| A Cart | Carts API | host backend | Must be created with the Carts API (`external`; confirmed 2026-10, https://docs.commercetools.com/checkout/installing-checkout). Field requirements: §3.10 |
| Session id | Sessions API (§3.2) | host backend | Bound to one cart. The example response in commercetools' docs shows `expiryAt` one hour after `createdAt`, but no lifetime policy is stated (§7) |
| Processor URL | The deployment's `processor` application (`connect.yaml:33-35`, `endpoint: /`) | operator (read from the deployment) | Per deployment. §2.2 |
| Enabler bundle URL | The deployment's `enabler` application (`connect.yaml:2-3`, `applicationType: assets`) serving `public/` | operator (read from the deployment) | Per deployment. §4.0, §2.2 |
| Stripe publishable key | Not needed by the host for the enabler — it fetches it (`…-mock.ts:357-367`, `:254-263`) | — | Only needed if your own code calls Stripe.js (e.g. a return page). Read it from `GET /operations/config` (§3.7) |
| Host origin in `ALLOWED_ORIGINS` | Deployment configuration (`connect.yaml:93-95`) | operator | Only path F needs it (`POST /express-config`). All other processor routes answer any origin (`processor/src/server/server.ts:40-43`, `origin: '*'`) |
| Registered payment-method domain in Stripe | Stripe Dashboard → Payment method domains, or `POST /v1/payment_method_domains` | operator | Required for Apple Pay; also listed for Google Pay, Link, PayPal, Klarna (`external`; confirmed 2026-10, https://docs.stripe.com/payments/payment-methods/pmd-registration?dashboard-or-api=api). Every domain and subdomain that shows the button, in sandbox and live (same source) |
| A return page at `MERCHANT_RETURN_URL` | Deployment configuration (`connect.yaml:90-92`) | operator sets it; host implements the page | One URL per deployment unless the session principal supplies one (`processor/src/services/stripe-payment.service.ts:779`; §5.4). **Must be a valid absolute URL on every path, not only for redirects** — the enabler parses it before every confirmation (§5.4) |
| **Paths A–C:** an active Checkout **Application** and its `applicationKey` | Merchant Center → Checkout → Add application (§2.5) | operator | Per Project; several allowed (per country, brand or domain). Its key goes into every Checkout Session (§3.2) |
| **Paths A–C:** this connector added to the Application as a Payment Integration, activated | Application → Payment integrations tab (§2.5) | operator | Integrations and the Application are created **deactivated** (`external`; confirmed 2026-10, https://docs.commercetools.com/checkout/connectors-and-applications) |
| **Paths A–C:** your site's origin in the Application's **Origin URLs** | Application settings (§2.5) | operator | Only listed origins "can use Checkout"; an "allow all" toggle exists, "recommended for test purposes only" (same source) |
| **Paths A–C:** the cart's country among the Application's **countries** | Application settings → Select countries | operator | Otherwise Checkout emits `unsupported_country` (`external`; confirmed 2026-10, https://docs.commercetools.com/checkout/messages) |
| **Paths A–C:** the Checkout Browser SDK in your page | npm `@commercetools/checkout-browser-sdk`, or the loader script from `unpkg.com/@commercetools/checkout-browser-sdk@latest/browser/sdk.js` (§4.10) | host | `external`; confirmed 2026-10, https://docs.commercetools.com/checkout/browser-sdk. The SDK's required configuration is only `projectKey`, `sessionId`, `region` (plus `countryCode` for Express); no processor URL, enabler URL or publishable key appears in it — Checkout reaches the connector through the Application's Payment Integration (same source; https://docs.commercetools.com/connect/templates/payment-integration, "enabler -- Static assets --> composable_checkout") |

### 2.1 Loading the bundle

Moved: the files, how to load them and what they export are in **§4.0 Distribution**; the Content
Security Policy the page needs is in **§3.15**.

### 2.2 Finding the deployed URLs

- A Connect service application's URL has the form `{connect-provided-url}/{endpoint}`, e.g.
  `https://service-XYZ.europe-west1.gcp.commercetools.app/service` (`external`; confirmed 2026-10,
  https://docs.commercetools.com/connect/development). The processor's endpoint is `/`
  (`connect.yaml:35`), so its URL is the base URL and routes hang off it (`{processorUrl}/payments`).
- A Deployment is read with `GET https://connect.{region}.commercetools.com/{projectKey}/deployments/{id}`
  (or `key={key}`), and "You can check the `details` field within the Deployment to view its
  configuration" (`external`; confirmed 2026-10, https://docs.commercetools.com/connect/deployments,
  https://docs.commercetools.com/connect/getting-started). In Merchant Center: Manage connectors →
  Installations → select the connector (`external`; confirmed 2026-10,
  https://docs.commercetools.com/merchant-center/connect).
- The exact field holding each application's URL, and the URL form of an **assets** application,
  are not documented on the pages read (§7). The bundle path inside that URL is fixed by the build:
  `/connector-enabler.es.js` or `/connector-enabler.umd.js`.
- On paths A–C you need none of these URLs in your code (§2); you need them only to read the
  network tab, the processor's logs (§5.4), or to call §3.7/§3.8 yourself.

### 2.3 Which code a deployment runs

A Connector references a git repository `url` and `tag`; changing code means a new tag via Set
Repository, then Publish and Redeploy (`external`; confirmed 2026-10,
https://docs.commercetools.com/connect/connectors-staged, https://docs.commercetools.com/connect/getting-started).
Resolve the deployment's connector tag to a commit and compare it with the commit this context
describes (stated by the edition stamp, if this context is consumed as a published edition); differences confined to `context/` and `CLAUDE.md` files do not change
runtime behaviour. `GET /operations/status`
returns a `version` and SDK versions (`processor/src/dtos/operations/status.dto.ts:30-43`) but
requires a Merchant Center JWT (`processor/src/routes/operation.route.ts:51-55`), so a storefront
cannot call it.

### 2.4 Reading the deployed settings, and changing them

Every setting is read once, when the processor process starts (`processor/src/config/config.ts:232-337`,
module-level). Changing one therefore requires the processor to restart, which on Connect means a
redeploy; `STRIPE_PAYMENT_FLOW` says so explicitly (`processor/src/config/config.ts:313`). Whether
editing configuration in Merchant Center triggers that redeploy by itself is not documented (§7).

| Setting | How a host can read it | Notes |
| --- | --- | --- |
| Effective capture method, flow type (`deferred`/`pi_first`), billing-address collection, layout, `setup_future_usage`, appearance — **for this cart** | `GET /config-element/payment` with `x-session-id` (§3.8) | Includes per-cart `STRIPE_PAYMENT_BEHAVIOR_RULES` (`stripe-payment.service.ts:1880-1883`) |
| Global capture method, publishable key, appearance, Express element options | `GET /operations/config` with `x-session-id` (§3.7) | `environment` here is `MOCK_ENVIRONMENT` (default `TEST`), not Stripe's mode (`stripe-payment.service.ts:216`) |
| `MERCHANT_RETURN_URL` | Only in the `GET /payments` response (`merchantReturnUrl`) | **Do not probe with it**: the first call creates a PaymentIntent and a Payment on the cart (`stripe-payment.service.ts:875,900-942`); a repeat on an unchanged cart reuses that pair (§3.10) |
| `ALLOWED_ORIGINS` | Probe `POST /express-config` with your `Origin`: 200 = allowed or list empty, 403 = not allowed (`processor/src/libs/fastify/cors/cors.ts:10-33`) | An empty list allows every origin (`cors.ts:12-15`) |
| Everything else | Deployment `details` / Merchant Center (§2.2) | Whether secured values are returned is not documented (§7) |

### 2.5 The Checkout Application and its `applicationKey` (paths A–C)

Everything in this subsection is `external` — confirmed 2026-10,
https://docs.commercetools.com/checkout/connectors-and-applications, except where another source is named.
None of it is visible in this repository.

**What it is.** "An Application lets you set a specific configuration for Checkout, such as
country-specific or brand-specific checkout flows." It is a Project-level Checkout resource holding:
mode, countries, allowed origins, payment return URL, and the Payment Integrations that say which
installed connector renders payments. A Checkout Session names exactly one Application through
`metadata.applicationKey` (§3.2); that is how a session "selects" this connector.

**Prerequisite:** the connector is installed from Connect first — "you must install at least one
Connector from Connect because Connectors are required to set the Payment Integrations".

**Create it** — Merchant Center → **Checkout → Add application** → **Add complete checkout** (path A,
and C) or **Add payment only** (path B). Then:

| Field | Value for this connector | Notes |
| --- | --- | --- |
| Application name | any | Merchant Center only |
| **Application key** | e.g. `web-de` — 2–256 chars, `A–Z a–z 0–9 _ -` | **This is the `applicationKey`** your backend sends in every Checkout Session. Chosen by you, not generated |
| Logo URL | Complete Checkout only | shown in Checkout's header |
| Select countries | every country your carts use | a cart outside them → `unsupported_country` (§4.12) |
| Origin URLs | your storefront's exact origin(s), e.g. `https://shop.example.com` | Validated against `/^(https?:\/\/)?(([a-zA-Z0-9-]+\.)+[a-zA-Z]{2,})\b(?::\d+)?(?!\/)$/i` — no path, no trailing slash. "Allow all" is for testing only (§6) |
| **Payment return URL** | the page where your checkout starts (Complete Checkout only) | "URL where the buyer will be redirected back to after an offsite payment" (`external`; confirmed 2026-10, https://docs.commercetools.com/checkout/applications-api). How it relates to `MERCHANT_RETURN_URL`: §5.4 |
| Discount code toggle | your choice | Complete Checkout only |

**Add the connector — Payment integrations tab:**

1. **Standard Payments → Add payment integration** → Connector: this connector → Specification:
   **Drop-in** (§1 "Not paths") → Drop-in integration name → Save. A *Payment integration ID* is generated;
   an optional *Payment integration key* is needed only for the Checkout Transactions API. Predicates,
   ordering and label customisation are **not** available for drop-in — which methods appear is
   decided by the connector and your Stripe account ("the rendering … totally depends on the Connector
   and on your third-party service account settings").
2. Path C: **Express Payments → Add payment integration** → Connector: this connector → **Express
   payment method** → name → Save. Which express methods the Merchant Center lists for this connector
   is not stated in this repository (§7); the enabler renders whatever wallets Stripe's Express
   Checkout Element offers (§4.5).
3. Toggle each integration's **Status** on, then the Application's **Status** on — both are created
   deactivated. A deactivated Application makes Checkout emit `application_disabled` (§4.12).

**Read it back by API** (optional): `GET https://checkout.{region}.commercetools.com/{projectKey}/applications/key={applicationKey}`
with scope `view_checkout_applications:{projectKey}`; the response carries `allowedOrigins`
(`allowAll`, `origins`), `mode`, and `paymentsConfiguration.paymentReturnUrl`
(`external`; confirmed 2026-10, https://docs.commercetools.com/checkout/applications-api).

**More than one domain.** "You can set only one return URL per Connector. If you want to use the
same Connector with multiple domains, you must create different Applications in the Merchant Center
and override the return URL" (`external`; confirmed 2026-10, https://docs.commercetools.com/checkout/browser-sdk).

## 3. Calls

**3a** is what your own code calls: 3.1–3.6 are calls your **backend** makes to commercetools, and 3.14
is the one processor endpoint your web server routes to. **3b** is what the enabler — the connector's
component — calls from your page: 3.7–3.13 to the processor and 3.15 to Stripe. You do not write the 3b
calls, but you see them in the network tab, your Content Security Policy must allow them, and you
would have to make them yourself on any path that does not use the enabler (§1, G1–G2). You may also call
3.7, 3.8 and 3.11 yourself when you need to (§2.4, §5.4).

**On paths A–C your backend makes only 3.1 and 3.2.1**, plus 3.3 if you supply your own Express
cart callbacks (§4.11) and 3.5 if you want to read the Payment. 3.4 and 3.6 are not yours: Checkout
creates the order and the connector writes its `paymentState` (§5.5). 3b still happens — Checkout's
copy of the enabler makes those calls — and shows up in your browser's network tab.

### 3a. Calls the host makes

#### 3.1 Obtain an access token
- **To:** `POST https://auth.{region}.commercetools.com/oauth/token` · **From:** host backend
- **Auth:** HTTP Basic `client_id:client_secret`
- **Request** — example (`enabler/dev-utils/session.js:3-27`):
  ```
  POST /oauth/token
  Authorization: Basic base64(<clientId>:<clientSecret>)
  Content-Type: application/x-www-form-urlencoded

  grant_type=client_credentials
  ```
- **Response:** `{ "access_token": "…", … }` — `access_token` is used as `Bearer`.
- **Errors:** non-200 means wrong credentials or region.

#### 3.2 Create the session
- **To:** `POST https://session.{region}.commercetools.com/{projectKey}/sessions` · **From:** host backend
- **Auth:** `Bearer` token with `manage_sessions` (`processor/README.md:119`; `external` — confirmed 2026-10, https://docs.commercetools.com/checkout/scopes)

##### 3.2.1 Paths A–C — a Checkout Session

Every fact in this variant is `external` — confirmed 2026-10,
https://docs.commercetools.com/checkout/installing-checkout, unless noted.

- **Request** — "you must provide the identifier of the Cart and of the Application":
  ```
  POST https://session.europe-west1.gcp.commercetools.com/my-project/sessions
  Authorization: Bearer <token with manage_sessions:my-project>
  Content-Type: application/json

  {
    "cart": { "cartRef": { "id": "a1b2c3d4-0000-4000-8000-000000000001" } },
    "metadata": {
      "applicationKey": "web-de",
      "futureOrderNumber": "WEB-2026-000123"
    }
  }
  ```

  | Field | Required | Meaning |
  | --- | --- | --- |
  | `cart.cartRef.id` | yes | A cart created with the Carts API. For Express on a product page the session may start **without** a cart; a cart must be attached before the Express flow starts (§4.11) |
  | `metadata.applicationKey` | yes | The Application's key (§2.5) — this is what selects the Application, and through it this connector |
  | `metadata.futureOrderNumber` | no | Stored as the Order's `orderNumber` when Checkout creates it. "Order numbers must be unique. If you send a duplicate Order number, an error occurs and the Order is not created" |
  | `metadata.processorUrl`, `allowedPaymentMethods` | not part of the documented Checkout Session body | Those are what the **connector's** payment sessions carry (§3.2.2); on A–C Checkout creates those itself (§1) |

  The documented request has **no** return-URL or merchant-URL field; the return URL comes from the
  Application and the connector (§5.4).
- **Response:**
  ```json
  { "id": "537ec3b7-01f5-47b6-8a5c-3974a8bc4812",
    "expiryAt": "2024-03-13T10:20:45.661Z", "lastModifiedAt": "2024-03-13T09:20:45.661Z",
    "createdAt": "2024-03-13T09:20:45.661Z",
    "metadata": { "applicationKey": "web-de" },
    "activeCart": { "cartRef": { "id": "a1b2c3d4-0000-4000-8000-000000000001" } },
    "state": "ACTIVE" }
  ```
  `id` is the `sessionId` you pass to `checkoutFlow`, `paymentFlow` or `expressPayment.init` (§4.10, §4.11).
  It is a different thing from the payment sessions Checkout then creates for the connector ("Checkout
  Sessions are specific to Checkout. They are different from payment sessions created with payment
  service providers").
- **Errors:** the error bodies of this endpoint are not documented on the pages read (§7). Problems
  with the session surface later in the browser as Checkout Messages: `expired_session`,
  `failed_to_refresh_session`, `cart_not_found`, `application_disabled` (§4.12).
- **Reuse:** "If the customer quits the checkout process before completing it but the Checkout
  Session is still valid, you can call the method again with the same `sessionId`. If the session has
  expired, you can refresh it and open the component again by getting a new `sessionId`"
  (`external`; confirmed 2026-10, https://docs.commercetools.com/checkout/browser-sdk).

##### 3.2.2 Paths D–F — a session for the enabler

- **Request** — direct host, as this repository builds it (`processor/README.md:116-132`; `enabler/dev-utils/session.js:29-61`):
  ```json
  {
    "cart": { "cartRef": { "id": "a1b2c3d4-0000-4000-8000-000000000001" } },
    "metadata": {
      "processorUrl": "https://service-xxxxxxxx.europe-west1.gcp.commercetools.app",
      "allowedPaymentMethods": ["dropin"]
    }
  }
  ```
  `metadata.checkoutTransactionItemId` is optional and is copied onto the created Payment
  (`processor/README.md:129`; read at `processor/src/services/stripe-payment.service.ts:903-905`).
- **Response** — fields per commercetools' example (`external`; confirmed 2026-10, https://docs.commercetools.com/checkout/installing-checkout):
  ```json
  { "id": "<sessionId>", "expiryAt": "…", "createdAt": "…", "lastModifiedAt": "…",
    "metadata": { … }, "activeCart": { "cartRef": { "id": "a1b2…0001" } }, "state": "ACTIVE" }
  ```
  `id` is what `new Enabler({ sessionId })` takes and what the enabler sends as `x-session-id`.
  The processor defines readers for `cartId`, `allowedPaymentMethods`, `paymentInterface`, `processorUrl`,
  `merchantReturnUrl` and `checkoutTransactionItemId` on the session principal (`processor/src/libs/fastify/context/context.ts:42-71`);
  only `cartId`, `merchantReturnUrl` and `checkoutTransactionItemId` are ever called (§4.14).
- **Errors:** non-2xx → no session; `enabler/dev-utils/session.js:56-58` throws "Not able to create session".
- **Security:** verify the cart belongs to the requesting shopper before creating a session for it
  (`external` — compare `customerId`/`anonymousId`; confirmed 2026-10,
  https://docs.commercetools.com/learning-implement-checkout/implement-commercetools-checkout/set-up-checkout).

#### 3.3 Update the cart from Express callbacks (paths E, F; C only if you pass your own callbacks — otherwise Checkout updates the cart, §4.11)
- **To:** `POST https://api.{region}.commercetools.com/{projectKey}/carts/{cartId}` and
  `GET …/{projectKey}/shipping-methods/matching-cart?cartId={cartId}` · **From:** host backend (proxied from your browser callbacks)
- **Auth:** `Bearer` with `manage_orders` (and `view_shipping_methods` for the lookup)
- **Request** — examples from `enabler/dev-utils/checkout.js:73-171`:
  ```json
  { "version": 7, "actions": [ { "action": "setShippingAddress",
      "address": { "country": "DE", "postalCode": "10115", "city": "Berlin" } } ] }
  ```
  ```json
  { "version": 8, "actions": [ { "action": "setShippingMethod",
      "shippingMethod": { "typeId": "shipping-method", "id": "<shipping-method-id>" } } ] }
  ```
  `setBillingAddress` takes the same `address` shape. The enabler's `ExpressAddressData`
  (§4.5) maps onto these fields; `state` must be written as `region` (`enabler/dev-utils/checkout.js:104-116`).
- **Response:** the updated Cart.
- **Errors:** 409 on a stale `version` — re-read the cart and retry. If your callback rejects, the
  enabler rejects the wallet event (§4.6).

#### 3.4 Create the Order (paths D–F only)
- **To:** `POST https://api.{region}.commercetools.com/{projectKey}/orders` · **From:** host backend
- **Auth:** `Bearer` with `manage_orders`
- **Request** — example:
  ```json
  { "cart": { "typeId": "cart", "id": "a1b2c3d4-0000-4000-8000-000000000001" }, "version": 9 }
  ```
  `cart` is required (`external`; confirmed 2026-10, https://docs.commercetools.com/api/projects/orders);
  the remaining `OrderFromCartDraft` fields were not confirmed in this research (§7).
- **Response:** the Order; it carries the cart's payments in `paymentInfo` — each `GET /payments`
  that created a Payment added one (`stripe-payment.service.ts:936-942`); a repeat that reused one
  added none (§3.10).
- **When:** §5.3 — the moment you create the order decides whether `Order.paymentState` is ever set.

#### 3.5 Read the Payment to decide the outcome
- **To:** `GET https://api.{region}.commercetools.com/{projectKey}/payments/{paymentReference}` · **From:** host backend
- **Auth:** `Bearer` with `view_payments` or `manage_payments` (`external`; confirmed 2026-10, https://docs.commercetools.com/api/scopes)
- **Request:** none beyond the path. `paymentReference` is the commercetools Payment id
  (`stripe-payment.service.ts:957`) — from `onComplete`, or the `paymentReference` query parameter on the return URL (§5.4).
- **Response — the fields that matter:**
  ```json
  { "id": "<paymentReference>", "interfaceId": "pi_…",
    "paymentMethodInfo": { "paymentInterface": "checkout-stripe" },
    "amountPlanned": { "centAmount": 12900, "currencyCode": "EUR", "fractionDigits": 2 },
    "transactions": [
      { "type": "Authorization", "state": "Success", "interactionId": "pi_…" },
      { "type": "Charge", "state": "Success", "interactionId": "pi_…" } ] }
  ```
  Meaning of each transaction combination: §5.2.
- **Errors:** 404 if the id is wrong.

#### 3.6 Set `Order.paymentState` yourself (only where the connector will not — §5.3)
- **To:** `POST https://api.{region}.commercetools.com/{projectKey}/orders/{orderId}` · **From:** host backend
- **Auth:** `Bearer` with `manage_orders`
- **Request** — the same action the connector uses (`processor/src/services/stripe-payment.service.ts:2572-2581`):
  ```json
  { "version": 3, "actions": [ { "action": "changePaymentState", "paymentState": "Paid" } ] }
  ```
- **Response:** the Order. **Errors:** 409 → re-read; if a state is already set, leave it — the
  connector never downgrades `Paid` and writes `Pending` only onto an unset state (`processor/src/utils.ts:154-159`).

#### 3.14 `GET /applePayConfig`
- **To:** `{processorUrl}/applePayConfig` · **From:** whatever serves your `/.well-known/apple-developer-merchantid-domain-association`
- **Auth:** none — the endpoint stands in for a public domain-association file. The route registers no `preHandler`
  (`processor/src/routes/stripe-payment.route.ts:418-421`).
- **Request:** `GET /applePayConfig`.
- **Response:** 200, the configured `STRIPE_APPLE_PAY_WELL_KNOWN` string verbatim; default `mockWellKnown` (`processor/src/routes/stripe-payment.route.ts:419-422`; `processor/src/config/config.ts:258`).
- **How it was meant to work:** the connector's README tells the storefront to redirect its well-known
  path to this endpoint (`enabler/README.md:11-15`). Note that `connect.yaml:86` gives a **URL** as the
  example value while `processor/.env.template:37` asks for the file **contents**; the endpoint
  returns whichever string was configured, so a URL there serves the URL text, not the file.
- **What Stripe documents today:** register each domain that shows Apple Pay (§2) — "Stripe handles
  Apple merchant validation for you … Do not follow the merchant validation process in Apple's
  documentation" (`external`; confirmed 2026-10, https://docs.stripe.com/apple-pay?platform=web). The
  pages read no longer mention hosting the association file, so whether this endpoint is still
  needed at all is not established (§7). Apple Pay that does not appear is first a registration or
  device problem, not an Express bug (§6).

### 3b. Calls the unit's component makes from the host's page

The enabler makes these from the page that loaded it — your page on D–F, Checkout's on A–C. Its calls
to the processor (3.7–3.13) carry the session id; its calls to Stripe (3.15) go through Stripe.js.

#### Common processor error envelope

Errors thrown inside the processor are serialised by `processor/src/libs/fastify/error-handler.ts:20-60`:

```json
{ "message": "Amount must be at least €0.50 eur", "statusCode": 400,
  "errors": [ { "code": "amount_too_small", "message": "Amount must be at least €0.50 eur" } ] }
```

- A Stripe API failure keeps Stripe's HTTP status and `code` (`processor/src/clients/stripe.client.ts:19-27`,
  `processor/src/errors/stripe-api.error.ts:14-22`). The example's message text is illustrative.
- An authentication failure (missing, unknown or unusable session) adds `error` and
  `error_description` (`error-handler.ts:35-47`). The status code and messages come from
  `@commercetools/connect-payments-sdk` 1.2.2 and are not visible in this repository (§7).
- Any other exception becomes 500 `Internal server error.` (`error-handler.ts:32`).

#### 3.7 `GET /operations/config`
- **To:** `{processorUrl}/operations/config` · **From:** enabler (browser); you may call it to read settings
- **Auth:** `X-Session-Id: <sessionId>` (`processor/src/routes/operation.route.ts:35-49`)
- **Request:** `GET /operations/config` with the header; no body.
- **Response** (`processor/src/dtos/operations/config.dto.ts:6-18`; `stripe-payment.service.ts:213-222`):
  ```json
  { "environment": "TEST", "publishableKey": "pk_test_…", "captureMethod": "automatic",
    "appearance": "{\"theme\":\"night\"}", "expressElementOptions": "{\"buttonHeight\":48}" }
  ```
  `appearance` and `expressElementOptions` are strings of JSON and present only when configured.
- **Errors:** session errors per the envelope.

#### 3.8 `GET /config-element/payment`
- **To:** `{processorUrl}/config-element/payment` · **From:** enabler during setup (`…-mock.ts:357-367`)
- **Auth:** `X-Session-Id`
- **Request:** `GET /config-element/payment` (the path segment is always `payment`, `…-mock.ts:141`).
- **Response** (`processor/src/dtos/stripe-payment.dto.ts:46-58`; `stripe-payment.service.ts:1912-1924`):
  ```json
  { "cartInfo": { "amount": 12900, "currency": "EUR" },
    "appearance": "{\"theme\":\"night\"}", "captureMethod": "automatic",
    "layout": "{\"type\":\"tabs\",\"defaultCollapsed\":false}", "collectBillingAddress": "auto",
    "paymentElementOptions": "{}", "flowType": "deferred" }
  ```
  `cartInfo.amount` is the cart payment amount in minor units (cents), unconverted. `setupFutureUsage` appears only when set and never under `pi_first` (`:1890-1893`).
- **Errors:** session errors; cart read errors.

#### 3.9 `GET /customer/session`
- **To:** `{processorUrl}/customer/session` · **From:** enabler during setup (`…-mock.ts:433-444`)
- **Auth:** `X-Session-Id`
- **Request:** `GET /customer/session`.
- **Response:** 204 for a cart without `customerId` (`processor/src/routes/stripe-payment.route.ts:59-65`;
  `stripe-payment.service.ts:626-631`); otherwise 200
  `{ "stripeCustomerId": "cus_…", "ephemeralKey": "ek_…", "sessionId": "cuss_…_secret_…" }`.
  For a logged-in customer the processor finds or **creates** a Stripe customer and stores its id on the
  commercetools customer (`stripe-payment.service.ts:2852-2935`). Attach `customerId` only for the logged-in customer who owns the cart.
- **Errors:** session errors per the envelope.

#### 3.10 `GET /payments` — creates the PaymentIntent, or returns the cart's open one
- **To:** `{processorUrl}/payments` · **From:** enabler — on `submit()` (deferred), at setup (`pi_first`), or on Express confirm
- **Auth:** `x-session-id`; Express adds `x-express-checkout: true` and, when a Stripe customer was resolved at setup, `x-express-customer-session: true` (`enabler/src/express/dropin-express.ts:590-602`)
- **Request:** `GET /payments` with headers; no body, no query (`processor/src/routes/stripe-payment.route.ts:74-91`).
- **Response** (`processor/src/dtos/stripe-payment.dto.ts:32-38`; `stripe-payment.service.ts:955-961`):
  ```json
  { "sClientSecret": "pi_3Q…_secret_…", "paymentReference": "7c1d…-ct-payment-id",
    "merchantReturnUrl": "https://shop.example.com/checkout/return",
    "cartId": "a1b2c3d4-0000-4000-8000-000000000001",
    "billingAddress": "{\"name\":\"Ada Lovelace\",\"email\":\"ada@example.com\",…}" }
  ```
  `billingAddress` is present only when the effective `collectBillingAddress` is not `auto` (`:1407-1413`).
- **Side effects:** a Stripe PaymentIntent for the cart's payment amount in minor units, verbatim
  (`:777,1469-1470`), with `metadata.cart_id` set to the cart (`:1476`); a commercetools Payment with
  `Authorization/Initial` and key `pi-create-{cartId}-{cartVersion}` added to the cart (`:897-942`);
  `metadata.ct_payment_id` on the PaymentIntent (`:951`).
- **A repeat does not always create a new pair.** Before creating, the processor
  walks the cart's Payments (`:840-844` → `:1203-1352`):

  | The cart already carries a Payment of this connector with `Authorization/Initial`, the same amount and currency, and its PaymentIntent is… | Result |
  | --- | --- |
  | open (`requires_payment_method`, `requires_confirmation`, `requires_action`) and created with the same capture method, applied `setup_future_usage`, customer binding and shipping presence this request would use | **the same `sClientSecret` and `paymentReference` are returned**; nothing is created; log `Reusing the active payment already attached to the cart…` (`:1065-1076`). A missing `ct_payment_id` stamp is re-written first (`:1309-1328`) |
  | `succeeded`, `requires_capture` or `processing` | **the call fails** — `Error('A payment is already in progress for this cart')` (`:1281-1283`, `:1056-1062`), which the error envelope turns into 500 `Internal server error.` (`processor/src/libs/fastify/error-handler.ts:32`) |
  | anything else, or none qualifies | a new pair is created, as above |

  Two concurrent calls on the same cart version collide on the Payment key and the loser returns the
  winner's pair (`stripe-payment.service.ts:921-934` → `:1086-1153`). So: changing the cart total, currency, or the configuration a rule
  resolves to between two calls yields a new pair; a decline (PaymentIntent back to
  `requires_payment_method`) followed by a retry on the same cart reuses it.
- **What the cart must carry** (answers "which cart fields before `GET /payments`"):

  | Cart field | Required by this code? | Effect |
  | --- | --- | --- |
  | The cart itself, its currency and total | yes | Amount is `getPaymentAmount` of the SDK (`stripe-payment.service.ts:777`); how the SDK computes it is not visible (§7). Stripe rejects amounts below its minimum (`external` — "The minimum amount is $0.50 US or equivalent"; confirmed 2026-10, https://docs.stripe.com/js/elements_object/update) — arrives as `onError` with code `amount_too_small` |
  | `country` (or store) | only if `STRIPE_PAYMENT_BEHAVIOR_RULES` is configured | Selects the per-cart rule; matched on `cart.country`, then `cart.store.key`, never on addresses (`processor/README.md:212`) |
  | `shippingAddress` | no | When present (and not Express) it is sent as PaymentIntent `shipping` with `name = firstName + " " + lastName` (`stripe-payment.service.ts:776,1480,2982-3004`). Stripe marks `shipping.name` required (`external`; confirmed 2026-10, https://docs.stripe.com/api/payment_intents/create). Set first and last name on the address; whether an empty name is rejected was not tested (§7) |
  | `shippingMethod` | no | Not read by the processor |
  | `customerEmail` | no | Used only when creating a Stripe customer (`stripe-payment.service.ts:2907`) and in `billingAddress` (`:3020`) |
  | `billingAddress` | only when `collectBillingAddress` is `never` or `if_required` | Built from `billingAddress ?? shippingAddress` (`stripe-payment.service.ts:3006-3030`) and passed to `confirmPayment` as `billing_details` (`enabler/src/dropin/dropin-embedded.ts:161-165`). Stripe requires billing fields that the Payment Element was told not to collect (`external` — "Billing fields that are omitted in the Payment Element via the `fields` option required"; confirmed 2026-10, https://docs.stripe.com/js/payment_intents/confirm_payment) |
  | `customerId` | no | Enables saved methods and binds a Stripe customer; anonymous carts work (`stripe-payment.service.ts:775`, `:2969-2980` tolerate a missing customer) |
- **Errors:** session errors; Stripe errors with Stripe's status and `code` (`stripe-payment.service.ts:878-880`); 500
  `Internal server error.` when a payment is already in progress for the cart (above). The drop-in
  passes the parsed body to `onError` (`enabler/src/dropin/dropin-embedded.ts:136-139`).

#### 3.11 `POST /confirmPayments/{paymentReference}`
- **To:** `{processorUrl}/confirmPayments/{paymentReference}` · **From:** enabler after `stripe.confirmPayment` resolves; **you** may call it from a return page (§5.4)
- **Auth:** `x-session-id`
- **Request** (`processor/src/dtos/operations/payment-intents.dto.ts:72-75`):
  ```
  POST /confirmPayments/7c1d…-ct-payment-id
  Content-Type: application/json
  x-session-id: <sessionId>

  { "paymentIntent": "pi_3Q…" }
  ```
- **Response** (`processor/src/routes/stripe-payment.route.ts:116-143`):
  - `200 { "outcome": "approved" }` — PaymentIntent `succeeded` or `requires_capture`; writes `Authorization/Success` (`stripe-payment.service.ts:1658-1669`)
  - `202 { "outcome": "pending" }` — `processing`, or a bank transfer awaiting funds; writes `Authorization/Pending` (`:1653-1656`)
  - `400 { "outcome": "rejected", "error": "Payment confirmation failed" }` — the session cart does not reference the Payment (`:1572`, `:1686-1695`), Stripe unreachable, any other status, `metadata.ct_payment_id` ≠ path id or `metadata.cart_id` ≠ session cart (`:1712-1738`), amount or currency ≠ `amountPlanned` (`:1572-1630`). A 200 means the Payment is on the session cart and its PaymentIntent was created for that cart
- **Errors:** session errors per the envelope.

#### 3.12 `GET /express-payment-data`
- **To:** `{processorUrl}/express-payment-data` · **From:** enabler after each Express shipping change
- **Auth:** `x-session-id`
- **Request:** `GET /express-payment-data`.
- **Response** (`processor/src/dtos/stripe-payment.dto.ts:75-108`; `stripe-payment.service.ts:1789-1853`):
  ```json
  { "totalPrice": { "centAmount": 13900, "currencyCode": "EUR", "fractionDigits": 2 },
    "currencyCode": "EUR",
    "lineItems": [
      { "name": "Subtotal", "amount": { "centAmount": 12900, "currencyCode": "EUR", "fractionDigits": 2 }, "type": "SUBTOTAL" },
      { "name": "Standard", "amount": { "centAmount": 1000, "currencyCode": "EUR", "fractionDigits": 2 }, "type": "SHIPPING" } ] }
  ```
  With a `taxedPrice` the lines are `SUBTOTAL` (net) and `TAX` instead (`:1812-1826`).
- **Errors:** non-OK → the enabler raises "Failed to get express amount from processor" and rejects the wallet event.

#### 3.13 `POST /express-config` (path F only)
- **To:** `{processorUrl}/express-config` · **From:** enabler when constructed without `sessionId`
- **Auth:** none; the `Origin` header must be listed in `ALLOWED_ORIGINS`, unless that list is empty (`processor/src/libs/fastify/cors/cors.ts:10-33`)
- **Request:**
  ```
  POST /express-config
  Origin: https://shop.example.com
  Content-Type: application/json

  {}
  ```
- **Response:** same shape as §3.7 (`processor/src/routes/stripe-payment.route.ts:433-447`).
- **Errors:** `403 { "error": "Forbidden", "message": "CORS origin not allowed." }` → the enabler throws "Unauthorized error fetching express config" from `createExpressBuilder` (`…-mock.ts:319-324`).

#### 3.15 Stripe.js — what the enabler calls on Stripe
- **To:** Stripe.js, loaded from `js.stripe.com`, which calls `api.stripe.com` · **From:** the enabler, in your page
- **Auth:** the publishable key from 3.7 (or 3.13); the PaymentIntent's client secret from 3.10
- **Calls, in order** (drop-in; Express is the same from `elements.submit()` on, §4.5):
  ```js
  const stripe = await loadStripe(publishableKey);                       // …-mock.ts:256
  const elements = stripe.elements({ mode: 'payment', amount: 12900, currency: 'eur',
    capture_method: 'automatic', appearance, locale,
    customerOptions: { customer: 'cus_…', ephemeralKey: 'ek_…' },     // only with a customer (3.9)
    customerSessionClientSecret: 'cuss_…_secret_…', setupFutureUsage }); // …-mock.ts:284-299
  // pi_first instead: stripe.elements({ clientSecret, appearance, locale })  — …-mock.ts:274-282
  await elements.submit();                                               // dropin-embedded.ts:86
  await stripe.confirmPayment({ elements, clientSecret,
    confirmParams: { return_url: 'https://shop.example.com/checkout/return?cartId=…&paymentReference=…',
                     payment_method_data: { billing_details } },         // billing_details only when 3.10 returned billingAddress
    redirect: 'if_required' });                                          // dropin-embedded.ts:156-168
  await stripe.retrievePaymentIntent(clientSecret);                      // only after a confirmPayment error, to rescue a bank transfer — :184, :232
  ```
- **Response:** `{ paymentIntent }` or `{ error }`; what the enabler does with each is §4.4.
- **If you call the processor directly instead of the enabler (G1)**, these are the calls you must reproduce, with Elements options that
  match the PaymentIntent the processor creates (capture method, `setup_future_usage`, amount — read them
  from 3.8).
- **`@stripe/stripe-js` is bundled** into the enabler (no `external` in the Vite config); at runtime it
  loads Stripe.js from `js.stripe.com` through `loadStripe(publishableKey)` (`…-mock.ts:256`).
- **Content Security Policy.** If your site sets one, Stripe.js needs `connect-src https://api.stripe.com`,
  `frame-src https://*.js.stripe.com https://js.stripe.com https://hooks.stripe.com`,
  `script-src https://*.js.stripe.com https://js.stripe.com` (`external`; confirmed 2026-10,
  https://docs.stripe.com/security/guide). Add the enabler host to `script-src` and the processor host to `connect-src`.

---

## 4. The surface the host drives

### 4.0 Distribution

Two artifacts, one per kind of path. Your code loads exactly one of them.

| Artifact | Paths | Where its URL comes from | Module formats | Exported symbols |
| --- | --- | --- | --- | --- |
| **The enabler bundle** — two files in `public/` (`enabler/vite.config.ts:10-17`) | D–F (on A–C Checkout loads it, not you) | The deployment's `enabler` assets application (`connect.yaml:2-3`); finding its URL: §2.2 | ES module `connector-enabler.es.js`; UMD `connector-enabler.umd.js` (`enabler/vite.config.ts:15-17`) | **One:** `Enabler` (ES named export, `enabler/src/main.ts:1-3`; UMD global `Connector`, so `window.Connector.Enabler`, `enabler/vite.config.ts:14`). No type declarations ship: the type check runs with `noEmit` (`enabler/tsconfig.json:15`) and the package is private, not on npm (`enabler/package.json:3`) — the types in §4.1–4.7 are read from source |
| **The Checkout Browser SDK** | A–C | npm `@commercetools/checkout-browser-sdk`, or the loader from unpkg (§4.10, *Loading*) | npm import, or the `ctc` loader global (§4.10) | `checkoutFlow`, `paymentFlow`, `expressPayment`, `close`, `reloadPaymentMethods`, `retryOrderVerification` (`external`, §4.10) |

How to load the enabler bundle:

| File | How to load | What you get |
| --- | --- | --- |
| `connector-enabler.es.js` | `const { Enabler } = await import('<enablerUrl>/connector-enabler.es.js')` | named export `Enabler` (`enabler/src/main.ts:3`) |
| `connector-enabler.umd.js` | `<script src="<enablerUrl>/connector-enabler.umd.js"></script>` | global `Connector`, so `window.Connector.Enabler` (`enabler/vite.config.ts:14`) |

- Styles are injected by the JavaScript itself (`vite-plugin-css-injected-by-js`, `enabler/vite.config.ts:3,7`).
  There is no CSS file to link.
- `@stripe/stripe-js` is bundled; what it loads and calls at runtime, and the Content Security Policy
  that needs, is §3.15.
- A cross-origin dynamic `import()` needs CORS headers on the assets host; whether Connect's assets
  hosting sends them is not documented (§7). The UMD `<script>` tag does not need CORS.

**Which surface your code drives.** **4.1–4.9 are the enabler**, which your code drives only on paths
D–F. On paths A–C Checkout drives the enabler and your code drives the **Checkout Browser SDK**
(4.10–4.13); 4.1–4.9 then tell you what Checkout's copy of the enabler does underneath, which is where
several Checkout-side symptoms come from. 4.14 lists what either surface accepts and then ignores.

### 4.1 `new Enabler(options)`

`Enabler` is `MockPaymentEnabler` re-exported (`enabler/src/main.ts:1-3`); the name is historical,
it is the shipped implementation. The constructor only stores options (`…-mock.ts:101-103`); nothing
happens until a builder is requested.

| Option | Type | Required | Used? | Meaning |
| --- | --- | --- | --- | --- |
| `processorUrl` | string | yes | yes | Base URL of the processor, no trailing slash (`…-mock.ts:363-364`) |
| `sessionId` | string | yes for drop-in; omit for path F | yes | Sent as `X-Session-Id` (`…-mock.ts:387-395`) |
| `locale` | string | no | yes | §4.8 |
| `onComplete` | `(result: PaymentResult) => void` | no | yes | §4.4, §4.7 |
| `onError` | `(error: any) => void` | no | yes | §4.4, §4.7 — also receives Express cancellation |
| `onActionRequired` | `() => Promise<void>` | no | **never called** | `payment-enabler.ts:147`; §4.14 |

Any other key (the dev page passes `currency`, `enabler/index.html:671`) is ignored.
Types: `enabler/src/payment-enabler/payment-enabler.ts:127-160`; `PaymentResult` at `:198-215` is
`{ isSuccess: true, paymentReference: string } | { isSuccess: false }`.

### 4.2 Builders

| Method | Returns | What it does first | Notes |
| --- | --- | --- | --- |
| `createDropinBuilder('embedded')` | `Promise<PaymentDropinBuilder>` with `dropinHasSubmit: true` | `_Setup`: `GET /config-element/payment` + `GET /operations/config` in parallel, `loadStripe`, `GET /customer/session`, under `pi_first` also `GET /payments`; then creates Stripe Elements and the Payment Element (`…-mock.ts:137-192`) | Any other type throws (`:223-229`). Setup runs once per `Enabler` instance and a **rejected setup stays cached** — build a new `Enabler` to retry (`:108-112`). Under `pi_first` each new instance calls `GET /payments`, which creates a PaymentIntent and Payment unless the cart's open one qualifies for reuse (§3.10) |
| `createExpressBuilder('dropin')` | `Promise<PaymentExpressBuilder>` | With `sessionId`: `_Setup` with `pi_first` skipped (`:130-135`). Without: `POST /express-config` + `loadStripe` (`:311-355`) | Any other type throws (`:243-249`). Separate cache from the drop-in's |
| `createComponentBuilder(type)` | rejects for every type | `_Setup` | Not usable (§1) |

### 4.3 Drop-in component

`builder.build(options: DropinOptions)` returns the component synchronously
(`enabler/src/dropin/dropin-embedded.ts:47-55`).

| `DropinOptions` key | Used? |
| --- | --- |
| `showPayButton` | **overwritten to `false`** (`dropin-embedded.ts:72`) — the host always renders its own pay button |
| `onDropinReady` | never called (§4.14) |
| `onPayButtonClick` | never called (§4.14) — run your own validation before calling `submit()` |

| Method | Behaviour |
| --- | --- |
| `mount(selector: string)` | Mounts the Stripe Payment Element (`dropin-embedded.ts:76-82`) |
| `submit(): Promise<void>` | `elements.submit()` → `GET /payments` (deferred) or the cached setup response (`pi_first`) → `stripe.confirmPayment({ redirect: 'if_required', return_url })` → `POST /confirmPayments/:id` → `onComplete` (`:84-127`, `:242-269`). It never rejects; failures go to `onError` |
| unmount / update / destroy | none exposed |

**The amount is fixed at setup.** Elements are created with the cart amount read during
`createDropinBuilder` (`…-mock.ts:284-287`); under `deferred` the PaymentIntent is created at
`submit()` from the cart as it is then. Stripe requires the two to match (`external` — "This must
match what you set on the `stripe.elements` instance"; confirmed 2026-10,
https://docs.stripe.com/elements/express-checkout-element/accept-a-payment?payment-ui=elements). If the cart total
changes after setup, create a new `Enabler`.

Minimal direct-host example:

```js
const { Enabler } = await import(`${enablerUrl}/connector-enabler.es.js`);
const enabler = new Enabler({
  processorUrl,                 // §2.2
  sessionId,                    // §3.2, from your backend
  locale: 'de-DE',
  onComplete: (r) => { /* §4.4 */ },
  onError: (e) => { /* §4.4 */ },
});
const builder = await enabler.createDropinBuilder('embedded');
const dropin = builder.build({});
dropin.mount('#payment');
payButton.onclick = () => dropin.submit();
```

### 4.4 Drop-in callbacks — every case

| What happened | Callback | Arguments |
| --- | --- | --- |
| Synchronous success (card, wallet in the Payment Element, 3DS completed in Stripe's modal) | `onComplete` | `{ isSuccess: true, paymentReference }` (`dropin-embedded.ts:268`) |
| Async settlement: crypto `processing`, or bank transfer instructions shown (also when the shopper closed the instructions modal) | `onComplete` | `{ isSuccess: false }` — **no `paymentReference`** (`:263-266`, rescue at `:184-188`) |
| Validation failure in the element | `onError` | Stripe error from `elements.submit()` (`:86-90`) |
| `GET /payments` failed | `onError` | Processor error body (envelope above) (`:136-139`) |
| Hard decline (e.g. `card_declined`) | `onError` | The Stripe.js error: `type: 'card_error'`, `code`, `decline_code`, `message`, `payment_intent` (`:170-189`; fields `external`, confirmed 2026-10, https://docs.stripe.com/api/errors). `onComplete` is **not** called |
| PaymentIntent still `requires_action` after confirm (not a bank transfer) | `onError` | `Error('Payment requires additional action')` with `type: 'requires_action'`, `next_action` (`:205-210`) |
| PaymentIntent carries `last_payment_error` | `onError` | `Error(message)` with `type: 'payment_failed'`, `last_payment_error` (`:211-216`) |
| Stripe confirmed but `/confirmPayments` failed | `onError` | the string `"Error on /confirmPayments"` (`:253-255`). The payment may already be recorded by the webhook; check the Payment (§3.5) before treating it as failed |
| Redirect-based method chosen | none — the browser navigates to the return URL (§5.4) | — |

So in the drop-in: **`onComplete({ isSuccess: false })` always means pending, never failed**;
failures arrive only through `onError`. To get the Payment id in the
pending case, take the newest Payment on the cart whose `paymentMethodInfo.paymentInterface` is
`checkout-stripe` (or the configured `PAYMENT_INTERFACE`, `processor/src/config/config.ts:267`); an
attempt adds one unless it reused the cart's open Payment (§3.10).

### 4.5 Express component

`builder.build(options: ExpressOptions)` throws unless `initialAmount.centAmount` is a number and
`initialAmount.currencyCode` is a non-empty string (`enabler/src/express/dropin-express.ts:53-66`).
`mount(selector)` creates the Stripe Express Checkout Element with `shippingAddressRequired` and
`billingAddressRequired` forced `true`, plus the allow-listed options from `STRIPE_EXPRESS_ELEMENT_OPTIONS`
(`:136-142`; `…-mock.ts:26-28`), and mounts it; mounting again re-mounts (`:145-166`).

| `ExpressOptions` key | Signature | Called when | What the host must do / return |
| --- | --- | --- | --- |
| `initialAmount` | `{ centAmount: number, currencyCode: string, fractionDigits: number }` | read at `init()` and on every wallet `click` | Cart total in **minor units, unconverted** — commercetools `centAmount` as is. Becomes the Elements `amount` (`:113-134`) and the one line item shown at `click` (`:171-174`). `fractionDigits` is not read. Stripe expects "a positive integer … in the smallest currency unit", minimum $0.50 or equivalent (`external`; confirmed 2026-10, https://docs.stripe.com/js/elements_object/update) — the dev page's `0` fallback (`enabler/index.html:652`) is not a valid amount |
| `onPayButtonClick` | `() => Promise<{ sessionId: string }>` | On **every** wallet open, in the background after the click is resolved (`dropin-express.ts:181-212`); again as a fallback if shipping or confirm runs before it settled (`:257-275`) | Return the session id **for the cart being paid**. Path F: create the cart (and its line items) and the session here. Must be idempotent — it can run twice for one open. Rejecting → `onError(Error('Failed to get session ID for Express Checkout.'))` |
| `onShippingAddressSelected` | `({ address: ExpressAddressData }) => Promise<void>` | Wallet `shippingaddresschange` (`:284-290`) | Write the address to the cart (§3.3). The address is **redacted by the wallet** — typically only `country`, `city`, `state`, `postalCode`; no name or street (`external` — "browsers might anonymize the shipping address…"; confirmed 2026-10, https://docs.stripe.com/js/elements_object/express_checkout_element_shippingaddresschange_event) |
| `getShippingMethods` | `({ address }) => Promise<ExpressShippingOptionData[]>` | Right after the previous callback (`:292-294`) | Return `[{ id, name?, description?, amount?: { centAmount, currencyCode } }]` (`payment-enabler.ts:346-354`). `id` must be what you can set on the cart; `amount.centAmount` in minor units (`dropin-express.ts:297-302`). **An empty array rejects the address** in the wallet (`:311-313`) |
| `onShippingMethodSelected` | `({ shippingMethod: { id } }) => Promise<void>` | Automatically with the **first** returned method after every address change (`:304-306`), and on wallet `shippingratechange` (`:327-334`) | Set that shipping method on the cart. The enabler then reads `GET /express-payment-data` and updates the wallet total from the **cart** (`:307-310`, `:336-341`) — the cart is the source of the displayed amount |
| `onPaymentSubmit` | `(payload: ExpressPaymentSubmitPayload) => Promise<void>` | After the wallet authorises, **before** `GET /payments` (`:435-442`) | Persist only the keys present: `shippingAddress` and/or `billingAddress` (full addresses, `ExpressAddressData`), `customerEmail` (`payment-enabler.ts:400-413`). Skipped when none is present. Effectively required: if absent and a payload exists, the call fails and the payment is aborted. The PaymentIntent amount is read from the cart after this resolves |
| `onComplete` | `(result: { isSuccess: boolean, paymentReference?: string }) => void` | End of confirm | §4.7 |
| `onError` | — | **never called** (§4.14); errors go to the constructor's `onError` | — |
| `allowedCountries` | `string[]` | **never read** (§4.14) | — |

`ExpressAddressData` (`payment-enabler.ts:328-341`): `country` (always), `city`, `postalCode`,
`state`, `streetName`, `streetNumber`, `additionalStreetInfo`, `firstName`, `lastName`, `phone`,
`email`. `streetNumber` is the first word of the wallet's `line1` and `streetName` the rest; `firstName`
is the first word of the name (`dropin-express.ts:629-648`) — re-split if your
market writes the number after the street.

Missing `onShippingAddressSelected`, `getShippingMethods` or `onShippingMethodSelected` throws
"… not implemented" inside the handler, which rejects the wallet event (`enabler/src/express/base.ts:22-47`).

**Event sequence:** `click` → resolve immediately with `[{ name: 'Total', amount: initialAmount.centAmount }]`
(Stripe requires `resolve` within 1 second — `external`; confirmed 2026-10,
https://docs.stripe.com/js/elements_object/express_checkout_element_click_event) and start
`onPayButtonClick` → `shippingaddresschange` → your three shipping callbacks → `GET /express-payment-data`
→ wallet updated → (optional `shippingratechange`) → `confirm` → `elements.submit()` → `onPaymentSubmit`
→ `GET /payments` with `x-express-checkout: true` (PaymentIntent without `shipping`,
`stripe-payment.service.ts:1480`) → `stripe.confirmPayment` → `POST /confirmPayments/:id` → callbacks (§4.7).
`cancel` resets to the constructor's session id and calls the constructor's `onError` with an Error
whose `name` is `'CANCEL'` (`dropin-express.ts:354-359`) — revert any cart changes you made for the
wallet if you need to.

**Path F caveat:** without a session, Elements use the **global** capture method from
`/express-config` (`…-mock.ts:344`; `dropin-express.ts:130`), while the PaymentIntent uses the per-cart
rule (`stripe-payment.service.ts:778`). Stripe says the two "should match" (`external`; confirmed
2026-10, https://docs.stripe.com/js/elements_object/update). If `STRIPE_PAYMENT_BEHAVIOR_RULES` overrides
`captureMethod` for your carts, prefer path E.

### 4.6 Express — what each failure does to the wallet

| Failure | Wallet | Host sees |
| --- | --- | --- |
| A shipping callback rejects, or `/express-payment-data` fails | event `reject()` | constructor `onError(Error('Error updating shipping address.'))` or `'Error updating shipping method.'` (`dropin-express.ts:314-318`, `:342-346`) |
| `getShippingMethods` returns `[]` | address rejected | nothing |
| Anything during confirm (onPaymentSubmit, `GET /payments` — including the 500 for a payment already in progress, §3.10 — Stripe decline, `requires_action`, `/confirmPayments`) | `event.paymentFailed({ reason: 'fail' })`, so the sheet shows the failure and closes (`dropin-express.ts:475`) | constructor `onError(Error('Error during payment confirmation.'))` **and** `ExpressOptions.onComplete({ isSuccess: false })` (`:470-482`). The original error (e.g. the decline code) is **not** passed on |
| A second wallet `confirm` on the same component while one is running, or after one succeeded | ignored | **nothing** — no callback fires for the duplicate (`dropin-express.ts:412-415`, flags set at `:465`, cleared at `:481`). After a *failed* confirm the flag is cleared, so a retry runs again; a second component instance (re-mount) is not covered by this guard, only by the processor's reuse (§3.10) |

### 4.7 Express — outcome callbacks

| Outcome | Calls |
| --- | --- |
| Success | the constructor's `onComplete({ isSuccess: true, paymentReference })` (`dropin-express.ts:581`) **and then** `ExpressOptions.onComplete({ isSuccess: true, paymentReference })` (`:466-469`). If you pass the same function to both, it runs twice |
| `/confirmPayments` answered 202 `pending` | treated as success, as above |
| Failure | constructor `onError` + `ExpressOptions.onComplete({ isSuccess: false })` (§4.6) |
| Cancel | constructor `onError` with `name === 'CANCEL'` only |

Unlike the drop-in, Express has no bank-transfer rescue, and
`isSuccess: false` means failed. Because pending is reported as success, confirm against the Payment
(§3.5) before fulfilling.

### 4.8 Locale

Pass `locale` to the constructor. It is converted once: `xx`, `xx-YY` or `xx_YY`, any case; exact match,
then the base language (`es-MX` → `es`), then a region variant; otherwise `auto`
(`enabler/src/converters/locale.converter.ts:104-134`). It is applied when Elements are created
(`…-mock.ts:145,298,331`; `dropin-express.ts:132`). There is no method to change it later — build a new
`Enabler`. (Stripe itself now lists `locale` among the options `elements.update` accepts — `external`;
confirmed 2026-10, https://docs.stripe.com/js/elements_object/update — so the code comment at
`dropin-express.ts:118-119` saying otherwise is outdated; the enabler simply does not expose it.)
Wallet sheets use the device language regardless (same source).

### 4.9 Amounts and units — summary

Every amount crossing this surface is an **integer in the currency's minor unit**, exactly as
commercetools stores `centAmount`: `initialAmount.centAmount`, `ExpressShippingOptionData.amount.centAmount`,
`/config-element` `cartInfo.amount`, `/express-payment-data` amounts, and the PaymentIntent `amount`
(`stripe-payment.service.ts:1469`). The connector never divides by 10^fractionDigits. Stripe's line
items and Elements amount are "in the currency's subunit" (`external`; confirmed 2026-10,
https://docs.stripe.com/js/elements_object/express_checkout_element_click_event). Do not convert to decimals.

### 4.10 Checkout Browser SDK — `checkoutFlow` (A) and `paymentFlow` (B)

All of 4.10–4.13 is `external` — confirmed 2026-10, https://docs.commercetools.com/checkout/browser-sdk —
except lines citing this repository or another URL.

**Loading.** Either `npm install @commercetools/checkout-browser-sdk` and
`import { checkoutFlow, paymentFlow, expressPayment, close, reloadPaymentMethods, retryOrderVerification } from '@commercetools/checkout-browser-sdk'`,
or the loader snippet in `<head>`, which defines a queueing global `ctc` and injects
`https://unpkg.com/@commercetools/checkout-browser-sdk@latest/browser/sdk.js`; then call
`ctc('checkoutFlow', {...})`, `ctc('expressPaymentInit', {...})`, `ctc('expressPaymentMount', {...})`.
`@latest` floats; pin a version in npm if you need reproducible builds (versions follow semver).
Supported browsers: latest two versions of Chrome, Edge, Firefox, Safari.

**Options** (same object for both methods):

| Option | Type | Required | Meaning |
| --- | --- | --- | --- |
| `projectKey` | string | yes | Your Project key |
| `sessionId` | string | yes | The Checkout Session `id` (§3.2.1) |
| `region` | string | yes | e.g. `europe-west1.gcp` |
| `locale` | string | no, default `en` | `xx`, `xx-xx` or `xx-XX`; unsupported → `en` and an `unavailable_locale` warn Message. Whether Checkout forwards it to this enabler (§4.8) is not documented (§7) |
| `onInfo`, `onWarn`, `onError` | `(message) => void` | no | Receive Checkout Messages by severity (§4.12) |
| `logInfo`, `logWarn`, `logError` | boolean | no, default `false` | Log Messages to the console; "We recommend not activating them in production" |
| `styles` | object | no | CSS variables |
| `languageOverrides` | object | no | Texts and labels |
| `currencyLocale` | string | no | Price formatting locale, e.g. `de-CH` |
| `showExtensionErrorMessages` | `{ address: boolean }` | no | Show address-extension errors instead of a generic one |
| `paymentReference` | string | no | Only when re-entering after a redirect (§5.4) |
| `forms` | object | no — `checkoutFlow` only | Address form fields |
| `tax` | `{ display: true }` | no — `checkoutFlow` only | Show tax in the summary |
| `skipPaymentSuccessPage`, `skipPaymentErrorPage` | boolean | no — `checkoutFlow` only | Suppress Checkout's own result pages; you then rely on Messages |
| `shipping` | `{ getShippingMethods, onShippingMethodSelected }` | no — `checkoutFlow` only | External shipping methods: `getShippingMethods()` (no arguments) → `Promise<ExternalShippingMethodItem[]>`; `onShippingMethodSelected({ shippingMethod: { id } })` → `Promise<{ isSuccess: boolean; message?: string }>`, and **you** apply it to the cart (e.g. `setCustomShippingMethod`). Omit to let Checkout use commercetools shipping methods |

**Placement.** By default the component is full screen in an absolutely positioned `<div>`;
`checkoutFlow` adds a header and a **Leave checkout** button. Put `<div data-ctc></div>` (or a `<span>`)
in your page to render inline instead — then there is no header and no Leave button.

**Minimal path A example:**

```js
import { checkoutFlow } from '@commercetools/checkout-browser-sdk';

checkoutFlow({
  projectKey: 'my-project',
  region: 'europe-west1.gcp',
  sessionId,                      // from your backend, §3.2.1
  locale: 'de',
  onInfo: (m) => {
    if (m.code === 'checkout_completed') location.href = `/thank-you?orderId=${m.payload.order.id}`;
  },
  onError: (m) => { /* §4.12 — e.g. expired_session → new session, order_creation_error → support */ },
});
```

**`paymentFlow` specifics (B).** It "creates payment sessions for all active payment methods that
match your payment predicates configuration, using the current Cart total amount"; if the cart total
changes afterwards (discount code, shipping), call `reloadPaymentMethods()`. For payment as an
intermediate step: an element with `data-ctc-selector="confirmMethod"` plus your own
`<button data-ctc-selector="paymentButton">`, shown or hidden on the selection-confirmation Message
by its `hasVendorButton`; a single `<div data-ctc-selector="vendorButton">` for vendor buttons. Custom and
vendor buttons work **only for web-components** integrations — not for this connector, which is
drop-in (§1). Terms: render `<span data-ctc-selector="termsAndConditionsPending" />` while terms are
unaccepted; a payment attempt then emits `external_terms_and_conditions_pending`. After calling
`paymentFlow`, do not navigate away — except client-side routing in an SPA, and then do not unmount it.
Retry after `payment_failed` / `payment_cancelled` by calling `paymentFlow` again with the same `sessionId`.

### 4.11 Checkout Browser SDK — `expressPayment` (C)

**Two steps:** `expressPayment.init(config)` **once** per page, then `mount()` or `mountMethod()` per
placement.

`init` options: `projectKey`, `sessionId`, `region`, **`countryCode`** (required, ISO 3166-1
alpha-2 of your store), `locale`, `onInfo`/`onWarn`/`onError`, `logInfo`/`logWarn`/`logError` — the
same meaning as 4.10. "The `sessionId` used for Express Payments does not need to have a Cart
associated with it initially."

Placement: `<div data-ctc-express></div>` for `mount()`; for per-method placement,
`<div data-ctc-express="googlepay"></div>` etc., `const methods = await expressPayment.getAvailableMethods()`
(each `{ type, paymentIntegrationId, connectorId }`), then `expressPayment.mountMethod({ expressId: method.type, method, ... })`.
Two bare `data-ctc-express` containers without `expressId` → `express_multiple_containers_found`.

`mount` / `mountMethod` options:

| Option | Required | Default when omitted | Corresponds in the enabler to |
| --- | --- | --- | --- |
| `expressId` | no | the single `[data-ctc-express]` element | — |
| `initialAmount` `{ currencyCode, centAmount, fractionDigits, type?: 'centPrecision' }` | yes | — | `ExpressOptions.initialAmount` — **minor units**, must be ≥ Stripe's minimum (§4.5, §4.9) |
| `method` | `mountMethod` only | — | — |
| `onPayButtonClick: () => Promise` | **mandatory when the session has no cart yet** (e.g. product page) | — | `ExpressOptions.onPayButtonClick` (§4.5). Create the cart, add the product, and attach the cart to the session. "When the Express Payments flow starts, the Checkout Session **must** have a Cart associated with it" |
| `onShippingAddressSelected({ address })` | no | "the Cart is automatically updated with the partial address" | same name (§4.5) — partial address only |
| `getShippingMethods()` | no (but pairs with the next) | fetched automatically | same name (§4.5) — an empty list rejects the address in the wallet (`enabler/src/express/dropin-express.ts:311-313`) |
| `onShippingMethodSelected({ shippingMethod })` | no (but pairs with the previous) | "the Cart is automatically updated" | same name |
| `onPaymentSubmit({ shippingAddress, billingAddress, customerEmail })` | no | "the Cart is automatically updated with the shipping and billing addresses and customer email" | same name (§4.5) |

"If you need more control … you must provide both `getShippingMethods` and `onShippingMethodSelected`."
Your callbacks update the cart through your backend (§3.3). How Checkout maps an Express shipping
item's `isSelected`, or your callback's rejection, onto the enabler is not documented (§7).

**What the enabler underneath does that you will see on C** (from this repository): the PaymentIntent
is created without shipping (`processor/src/services/stripe-payment.service.ts:1480`); a pending
confirmation is reported as success; confirm-stage failures lose the original
Stripe error (§4.6); on success the enabler calls **both** `onComplete` callbacks (§4.7). How Checkout
turns those into `express_payment_completed` / `express_payment_failed` is not documented (§7) — treat
`express_payment_completed` as "order created", and confirm the money against the Payment (§3.5) when
the rail can settle late.

Express shows **no error page**: "It is your responsibility to react to the `express_payment_failed`
and `express_payment_cancelled` Messages".

### 4.12 Checkout Messages — what the host receives

Every Message is an object
`{ severity: 'info' | 'warn' | 'error', code, message, payload?, correlationId }` delivered to
`onInfo`, `onWarn` or `onError` by severity. They are browser-side only; the backend equivalents are
Checkout Events through Subscriptions (`external`; confirmed 2026-10, https://docs.commercetools.com/checkout/checkout-events).
Codes, severities and payloads below are from the Messages reference (`external`; confirmed 2026-10,
https://docs.commercetools.com/checkout/messages).

**Outcome Messages** — the ones a host must handle:

| Code | Severity | Payload | Means / host action |
| --- | --- | --- | --- |
| `checkout_completed` | info | `{ order: { id } }` | Checkout finished and the component closed. Redirect to your confirmation page with the order id |
| `order_created` | info | `{ order: { id } }` | "Generated when an Order is created after a successful checkout process" |
| `express_payment_completed` | info | `{ order: { id } }` | Express finished with an order. Redirect |
| `payment_failed` | error | `{ id }` — a Payment reference | Show a failure; retry by calling the flow again with the same `sessionId` (B), or let Checkout's error page offer retry (A) |
| `express_payment_failed` | error | `paymentReference`, `error`, `method.type` (if available) | Show a failure — Checkout shows none for Express |
| `payment_cancelled` | info | `{ id }` — a Payment reference | Shopper cancelled the payment "for example, by closing the browser's window" |
| `checkout_cancelled` | info | — | Shopper left the checkout |
| `express_payment_cancelled` | info | `paymentReference`, `method.type` (if available) | Wallet sheet dismissed |
| `express_payment_interrupted` | info | — | One of **your** Express callbacks interrupted the flow |
| `payment_validation_failed` | info | `{ id }` — a Payment reference | Checkout and the PSP did not validate the entered data |
| `order_creation_error` | error | `paymentReference`, `sessionId`, `errors[]` (`code`, `message`) | **"Order that references an approved Payment cannot be created"** — money may have been taken with no order. Escalate; see §5.5 |
| `order_verification_timeout` | error | — | Order not verified in time; call `retryOrderVerification()` |
| `order_verification_retry_error` | error | `error`: `orderReferenceNotAvailable` or `orderVerificationOngoing` | The retry failed |
| `cart_with_existing_payment` | error | `{ cart: { id } }` | The cart already references an **approved** Payment |
| `non_orderable_cart_error` | error | `{ cart: { id, errors } }` | Cart inconsistent; order not created |
| `connector_error` | error | `{ connector: { id }, error?, message?, data? }` | The connector raised an error |

**Configuration and session Messages:** `expired_session` (error — create a new session),
`failed_to_refresh_session` (error), `init_error`, `init_timeout` (error — no configuration received
in time), `invalid_fields` (error, `invalidFields[]`), `invalid_mode` (info — wrong method for the
Application's mode, e.g. `paymentFlow` on a Complete Checkout Application), `application_disabled`
(error), `project_deactivated` (error), `cart_not_found`, `cart_empty`, `cart_emptied_during_checkout`,
`unsupported_country` (error, with `shippingCountry`, `billingCountry`, `supportedCountries`),
`shipping_address_missing`, `no_shipping_methods`, `set_shipping_address_error` (error),
`invalid_locale`, `unavailable_locale`, `deprecated_fields`, `updated_fields` (warn).

**Payment-integration Messages:** `payment_integrations_received` (info, `paymentIntegrations[]` with
`type`, `connectorId`), `payment_integration_loading` / `_loaded` (info), `payment_integration_loading_error`
(error, `error` + `integration`), `error_loading_all_payment_integrations` (error),
`no_payment_integrations` (error), `payment_integration_not_available` (warn),
`payment_integration_selected` / `payment_integration_selection_confirmation` (info, `integration.type`,
`hasVendorButton`), `payment_integration_selection_confirmation_failed` (info), `payment_started` (info),
`payment_validation_started` / `_passed` (info), `external_terms_and_conditions_pending` (info).
Express: `express_payment_started` (info, `integration.type`), `no_express_payment_integrations`,
`express_container_not_found`, `express_multiple_containers_found` (error),
`express_payment_integration_not_available` (warn). Discount codes and gift cards have their own
Messages in the same reference.

**A naming inconsistency in commercetools' own pages.** The Browser SDK page's sample handlers
switch on `payment_method_selection_confirmation`, `payment_methods_received`, `payment_method_loaded`,
`payment_method_selected`, `payment_method_loading_error` and `payment_completed`; the Messages reference
names the same events `payment_integration_*` and has **no** `payment_completed`. Which strings the
current SDK emits was not tested (§7). Match on both spellings for these, and do not rely on
`payment_completed`. All outcome codes in the table above appear identically on both pages.

**How enabler behaviour reaches these Messages.** The only evidence in this repository: a drop-in
`onError` "surfaced as `payment_failed` on the host" (`enabler/src/dropin/dropin-embedded.ts:191-199`).
The mapping of the drop-in's `onComplete({ isSuccess: false })`
(pending) and of Express's double `onComplete` is not documented (§7).

### 4.13 Lifecycle and teardown

| Call | When |
| --- | --- |
| `close()` | Close the Checkout or Payment UI. "Recommended over unmounting the component, as it ensures that the necessary cleanup is performed." Use it for your own Leave button (A) or to go back to an earlier step (B); reopen with the same `sessionId` |
| `reloadPaymentMethods()` | B — the cart total changed after `paymentFlow` |
| `retryOrderVerification()` | After `order_verification_timeout` |
| `checkoutFlow` / `paymentFlow` again with the same `sessionId` | Shopper quit and the session is still valid, or after `payment_failed` (B) |
| … with `paymentReference` | Return from a redirect (§5.4) |
| New session | After `expired_session` |

There is no documented `unmount`/`destroy` for Express placements; how to remove mounted Express
buttons is not stated (§7).

### 4.14 Accepted but inert

Everything here is accepted without an error and then does nothing, or is a documented call that
always fails. A host that relies on any of it gets no signal that it was ignored.

| Accepted | What actually happens | Source |
| --- | --- | --- |
| Constructor option `onActionRequired` | Declared, never called | `enabler/src/payment-enabler/payment-enabler.ts:147` |
| Any other constructor key (the dev page passes `currency`) | Ignored | `enabler/index.html:671` |
| `DropinOptions.showPayButton` | Overwritten to `false` — you always render your own pay button | `enabler/src/dropin/dropin-embedded.ts:72` |
| `DropinOptions.onDropinReady`, `DropinOptions.onPayButtonClick` | Declared, never called — run your own validation before `submit()` | `payment-enabler.ts:276,282` |
| `ExpressOptions.onError` | Never called; Express errors go to the constructor's `onError` (§4.6) | `enabler/src/payment-enabler/payment-enabler.ts:477` |
| `ExpressOptions.allowedCountries` | Declared (`payment-enabler.ts:423`), never read — although the enabler's README documents it as restricting the Express wallets (`enabler/README.md:59`) | — |
| `ExpressOptions.initialAmount.fractionDigits` | Not read (§4.5) | no occurrence of `fractionDigits` in `enabler/src/express/` or `enabler/src/payment-enabler/payment-enabler-mock.ts` |
| **Always fails:** `createComponentBuilder(type)` | Runs setup, then rejects for every type: its list of supported types is empty | `…-mock.ts:194-209` |
| **Always fails:** `createDropinBuilder(type)` for any type but `'embedded'` — including `'hpp'`, which is commented out | Throws "Component type not supported" | `…-mock.ts:218-229` |
| **Always fails:** `createExpressBuilder(type)` for any type but `'dropin'` | Throws "Express checkout type not supported" | `…-mock.ts:239-249` |
| Checkout SDK, path B: custom pay button (`data-ctc-selector="paymentButton"`) and vendor button containers | Work only for web-components integrations; this connector is drop-in (§1, §4.10) | `external`; confirmed 2026-10, https://docs.commercetools.com/checkout/browser-sdk |

---

## 5. Outcome

**If the flow leaves your page** (a redirect-based payment method), the shopper comes back to the effective return URL — the session principal's
`merchantReturnUrl`, else `MERCHANT_RETURN_URL` — with `cartId`, `paymentReference`, `payment_intent`
and `payment_intent_client_secret` in the query (§5.4). **What does not run on that route:** the
enabler is gone, so nobody calls `POST /confirmPayments`, and neither `onComplete` nor `onError` fires;
only webhooks record the result. Where you resume: on D–F, your return page reads the Payment (§3.5)
and creates the order (§5.3); on A–B, you call `checkoutFlow` / `paymentFlow` again with
`paymentReference` and Checkout finishes (§5.4, *Returning on path A*); on C and on direct Express
(E, F), which wallets can leave the page at all is not established (§7). The session id is not in the
URL — keep it yourself.

**Callback values that do not mean their names:**

| Value | What it means | Where |
| --- | --- | --- |
| Drop-in `onComplete({ isSuccess: false })` | **Pending**, never failed — a bank transfer awaiting funds or a `processing` rail. Failures arrive only through `onError` | §4.4 |
| Express `onComplete({ isSuccess: true, … })` | Paid **or pending** — a 202 `pending` from `/confirmPayments` is reported as success | §4.7 |
| Express `ExpressOptions.onComplete({ isSuccess: false })` | Failed — and it is always accompanied by the constructor's `onError` with a generic message | §4.6 |
| Drop-in `onError("Error on /confirmPayments")` | Not "failed": Stripe confirmed, the synchronous record failed; the payment may be paid | §4.4 |
| Constructor `onError` with `name === 'CANCEL'` | The shopper dismissed the Express wallet; not an error | §4.5, §4.7 |
| Checkout Message `express_payment_completed` | An order was created; not that the money has settled | §4.11 |

### 5.1 What the host learns, and from where

| Source | Meaning |
| --- | --- |
| Drop-in `onComplete({ isSuccess: true, paymentReference })` | Stripe accepted the payment and the Payment now has `Authorization/Success` (200 `approved`) |
| Drop-in `onComplete({ isSuccess: false })` | Pending: the Payment has `Authorization/Pending`; money expected later |
| Drop-in `onError(…)` | Not paid, **or** paid but not recorded synchronously (`"Error on /confirmPayments"`) — check §3.5 |
| Express `onComplete` | §4.7 — success may also be pending |
| Return-URL page | §5.4 |
| Paths A–C: Checkout Messages `checkout_completed` / `express_payment_completed` / `payment_failed` / `order_creation_error` … | §4.12, §5.5 — the host never sees the enabler's callbacks on these paths |
| commercetools Payment transactions (§3.5) | **The authoritative state.** Webhooks keep writing after the page is gone |

### 5.2 Payment states in commercetools

| Transactions on the Payment | Means | Written by |
| --- | --- | --- |
| `Authorization/Initial` only | PaymentIntent created, nothing confirmed (abandoned attempt, or a redirect not yet returned) | `GET /payments` (`stripe-payment.service.ts:912-919`) |
| `Authorization/Success`, no `Charge` | Authorised; with `automatic` capture the charge webhook is still on its way; with `manual` capture it waits for a merchant capture | `/confirmPayments` (`:1658-1667`) |
| `Charge/Success` | Paid | webhook `payment_intent.succeeded` (`README.md:81`) |
| `Authorization/Pending` | Async rail in flight (bank transfer, crypto) | `/confirmPayments` 202 or webhook `processing` / bank-transfer `requires_action` (`README.md:83-84`) |
| `Authorization/Failure` | Declined, failed or cancelled | webhook `payment_failed` / `canceled` (`README.md:80,82`) |

A cart can carry several Payments from retried attempts; judge the newest one, or any with
`Charge/Success`.

### 5.3 Who does what next

**The connector by itself:** records every transaction above from Stripe webhooks; writes
`Order.paymentState` through two writers — the `order-subscriber` at `OrderCreated`
(`Paid` if one of this connector's Payments has Charge/Success **and the order's charges cover its
gross total**, else `Pending` if one has Authorization/Pending, else nothing; only onto an unset
state — `order-subscriber/src/guard.ts:189-206`) and the processor on later webhooks, but for
`Paid`/`Failed` **only on orders it "owns"**: already `Pending`, or a Payment with
`Authorization/Pending` (`stripe-payment.service.ts:2307-2322,2472-2483`). It never creates an order.
The rules are in `business-rules/order-payment-state.md` — *unset-only* (the subscriber writes
only onto an unset state, `Paid` outranking `Pending`; Rule 6 "The subscriber records what is true at `OrderCreated`, onto an
empty field only"), *auth-without-charge* (an authorization without a charge leaves the order unset;
same Rule 6, manual-capture row) and *ownership* (the processor writes a terminal state only on an
order it owns; Rule 2 "The connector owns the order state only for asynchronous rails").

**Coverage.** Both writers require the settled money to cover the order's
tax-inclusive gross (`order.taxedPrice?.totalGross ?? order.totalPrice`), in the same currency,
summed over **all** the order's Payments so split tender counts. The subscriber sums persisted
`Charge/Success` transactions (`order-subscriber/src/guard.ts:81-130`, `:201-202`;
`order-subscriber/src/clients/order.client.ts:77-78`); the processor uses the PaymentIntent's
`amount_received` plus the other Payments' charges (`stripe-payment.service.ts:2346-2369`,
`:2500-2513`; shared rule `processor/src/utils.ts:200-206`; `business-rules/order-payment-state.md`
Rule 9 "`Paid` is written only when settled money covers the order's gross total"). Short coverage leaves `paymentState`
**unset** — not `Pending` — with a warning, for manual review. A host that sets an order total above
what was charged (a cart changed after payment, a discount applied after the charge) gets no
`paymentState`.

**The host (paths D–F):** creates the order (§3.4), and its timing decides whether
`Order.paymentState` is ever set:

| Rail | If you create the order… | `paymentState` you get | Recommendation |
| --- | --- | --- | --- |
| Card / wallet, `automatic` capture | right on `onComplete(true)` — before the `succeeded` webhook has written `Charge/Success` | **none, permanently**: the subscriber sees only `Authorization/Success` (*auth-without-charge*), and the later webhook is not "owned" (*ownership*) | Either wait until the Payment shows `Charge/Success` (poll §3.5), then create the order — the subscriber writes `Paid`; or create it at once and write `Paid` yourself (§3.6) when `Charge/Success` appears |
| Card / wallet, `automatic` capture | after `Charge/Success` is on the Payment | `Paid` (subscriber), if the charges cover the order total (*Coverage* above) | This is the timing commercetools Checkout produced in measurements (333–877 ms after `Charge/Success`, `order-subscriber/src/guard.ts:135-142`) |
| `manual` capture | any time | none — deliberately (*auth-without-charge*) | Set it yourself if you need one (`BalanceDue` is out of the connector's scope, `order-subscriber/src/guard.ts:148-155`) |
| Bank transfer / crypto (drop-in `onComplete(false)`) | on the pending signal | `Pending` (subscriber); later `Paid` by the processor, because the Payment has `Authorization/Pending` (*ownership*), if the settled amount covers the order (*Coverage* above) | Create the order on pending, as Checkout does (`stripe-payment.service.ts:2235-2238`). The cart stays mutable meanwhile (`processor/src/routes/stripe-payment.route.ts:299-305`) |
| Declined | — | — | Do not create an order; the shopper retries on the same cart and session. The declined PaymentIntent is back in `requires_payment_method`, so the retry reuses it and its Payment unless the amount or configuration changed (§3.10) |
| Redirect-based | after the return page established the result | as the rows above, by the final transaction | §5.4 |

`external` — commercetools recommends creating the order after payment and, for redirect methods,
creating it "asynchronously … based on payment transaction changes" (`PaymentTransactionAdded` /
`PaymentTransactionStateChanged` messages); confirmed 2026-10, https://docs.commercetools.com/tutorials/standard-checkout-flow.

### 5.4 After a redirect-based payment

- The return URL is the session principal's `merchantReturnUrl` if present, else `MERCHANT_RETURN_URL`
  (`stripe-payment.service.ts:779`). How a session obtains a principal `merchantReturnUrl` is not
  visible in this code (`processor/.env.template:12-13` calls the env var a fallback "if no
  merchantReturnUrl is provided in the session"); for paths A–C see §5.4.1, for D–F §7.
- The enabler appends `cartId` and `paymentReference` (`dropin-embedded.ts:152-154`;
  `dropin-express.ts:521-523`); Stripe appends `payment_intent` and `payment_intent_client_secret`
  (`external`; confirmed 2026-10, https://docs.stripe.com/js/payment_intents/confirm_payment). Example:
  `https://shop.example.com/checkout/return?cartId=a1b2…&paymentReference=7c1d…&payment_intent=pi_3Q…&payment_intent_client_secret=pi_3Q…_secret_…`
- **Nobody calls `/confirmPayments` after a redirect.** The enabler is gone when the page navigates.
  The Payment is still recorded by webhooks (`Charge/Success`, `Authorization/Pending` or
  `Authorization/Failure`).
- **What the return page must do:** read `paymentReference`, then decide from the Payment's
  transactions (§3.5), waiting briefly for the webhook if it shows only `Authorization/Initial`; then
  create the order per §5.3 or show a retry. Optionally it may call `POST /confirmPayments/{paymentReference}`
  with `{ "paymentIntent": "<payment_intent>" }` and the original `x-session-id` (keep the session id
  yourself — it is not in the URL) to write the authorization synchronously (§3.11).
- With commercetools Checkout, re-enter `checkoutFlow`/`paymentFlow` with `paymentReference` instead
  (`external`; confirmed 2026-10, https://docs.commercetools.com/checkout/browser-sdk) — see below.

**The return URL must be valid even when nothing redirects.** Both enabler flows build
`new URL(merchantReturnUrl)` before calling Stripe, for **every** payment method, card included
(`enabler/src/dropin/dropin-embedded.ts:152`; `enabler/src/express/dropin-express.ts:521`). A value
that is not an absolute URL (for example `http//:example.com`) makes that constructor throw a
`TypeError` ("Invalid URL"); the drop-in passes
it to `onError` (`dropin-embedded.ts:124-126`), Express turns it into its generic failure (§4.6). By
then `GET /payments` has already created a PaymentIntent and a Payment with `Authorization/Initial`
(§3.10), and Stripe is never asked to confirm. So set the effective return URL to a valid absolute
URL on every path — **it governs every payment**, not only redirects.

#### 5.4.1 Paths A–C: where the return URL comes from

- **commercetools' model** (`external`; confirmed 2026-10, https://docs.commercetools.com/checkout/browser-sdk):
  "when you install a Connector, you must set a return URL to take the customer back to your website …
  We recommend using the same URL as the one where the checkout process started"; "You can set only one
  return URL per Connector. If you want to use the same Connector with multiple domains, you must create
  different Applications … and override the return URL". The Application's override is its **Payment
  return URL** (Complete Checkout Applications only; `paymentsConfiguration.paymentReturnUrl` in the
  Applications API — §2.5). The Payment Only form has no such field, so on path B the connector's own
  value is the only one documented.
- **This connector's side.** Its "return URL set at install" is `MERCHANT_RETURN_URL`
  (`connect.yaml:90-92`). Its only other input is the session principal's `merchantReturnUrl`, which
  wins when present (`processor/src/libs/fastify/context/context.ts:68-71`;
  `processor/src/services/stripe-payment.service.ts:779`). Checkout creates the sessions the connector
  sees (§1), so the principal value is where an Application override would have to arrive.
- **Observed, not documented:** on path A, Checkout supplies a valid principal `merchantReturnUrl`.
  A deployment whose `MERCHANT_RETURN_URL` is not a valid URL processes payments on path A
  (observed 2026-10-15). Because the enabler parses the return URL before
  every confirmation (below), a payment could not succeed otherwise. *Where* Checkout takes the
  value from (the Application's Payment return URL, or elsewhere) is still not documented (§7). The documented Checkout Session request
  has no return-URL field (§3.2.1), so the host cannot supply one per session.
- **How to find out on a deployment, without guessing:** the processor logs the effective value at
  `info` on every `GET /payments` that creates a Payment — message `commercetools Payment and initial
  transaction created.`, field `merchantReturnUrl` (`processor/src/services/stripe-payment.service.ts:944-949`);
  a call that reuses the cart's open Payment logs `Reusing the active payment…` **without** that field
  (`:1065-1069`) — and returns it
  in every `GET /payments` response (`merchantReturnUrl`, §3.10), visible in the browser's network tab
  during a test payment. Because an invalid value fails every payment (above), **a single successful
  test-card payment on path A proves the effective URL is valid**, and the log line shows whether it
  came from Checkout or from `MERCHANT_RETURN_URL`.
- **What to configure, then:** set the Application's Payment return URL to the page where you call
  `checkoutFlow`, **and** set `MERCHANT_RETURN_URL` to a valid absolute URL of that same page, so the
  result is correct whichever of the two the connector ends up using.

**Returning on path A.** The enabler appends `cartId` and `paymentReference` itself (above); commercetools
documents that "the `paymentReference` parameter is added to the return URL with the `id` of the
Payment as its value". On that page call `checkoutFlow` (or `paymentFlow`) again with the same
`projectKey`, `region`, `sessionId`, `locale` **plus** `paymentReference`; keep the `sessionId` yourself
(it is not in the URL). Checkout then "displays a loading status while the payment is verified. If the
payment is successful, the checkout process is complete. Otherwise, the customer is prompted to either
quit the checkout process or try again" (`external`; confirmed 2026-10,
https://docs.commercetools.com/checkout/browser-sdk). You do **not** call `/confirmPayments` or create the
order on this path.

### 5.5 Outcome on paths A–C

**Who creates the order:** Checkout. The connector never does (`processor/src/services/stripe-payment.service.ts:2245-2251`),
and the payment-integration template puts cart-to-order conversion out of the connector's scope
(`external` — "Creating an Order from a Cart … is not in the scope of the payment integration
template"; confirmed 2026-10, https://docs.commercetools.com/connect/templates/payment-integration).
With `futureOrderNumber` in the session, that is the order's `orderNumber` (§3.2.1).

**What the host receives:** Checkout Messages only (§4.12) — never the enabler's `onComplete`/`onError`.

| Situation | Message(s) to the host | Order | `Order.paymentState` (this connector) |
| --- | --- | --- | --- |
| Card / wallet, `automatic` capture | `order_created` and `checkout_completed` (A, B) or `express_payment_completed` (C), each with `order.id` | created by Checkout after the charge | `Paid`, written by `order-subscriber` at `OrderCreated` — **because** Checkout created the order 333–877 ms after `Charge/Success` in the connector's measurements (`order-subscriber/src/guard.ts:135-142`). This is observed timing, not a documented contract: an order created before `Charge/Success` is recorded would stay unset (§5.3, first row). It also requires the charges to cover the order's gross total (§5.3, *Coverage*) |
| `manual` capture | as above | created | none — deliberately (`business-rules/order-payment-state.md`, *auth-without-charge*, §5.3) |
| Bank transfer awaiting funds (drop-in) | not established which Message (§7) | created **at the pending signal** — measured in the same second as `payment_intent.requires_action` (`processor/src/services/stripe-payment.service.ts:2234-2238`) | `Pending` (subscriber), later `Paid` by the processor when the money lands and covers the order (§5.3, *ownership*, *Coverage*) |
| Declined / failed | `payment_failed` (payload: the Payment's `id`); Express `express_payment_failed` | none | — . The drop-in's `onError` is what produces `payment_failed` (§4.12) |
| Cancelled | `payment_cancelled`, `checkout_cancelled`, `express_payment_cancelled` | none | — |
| Payment approved, order **not** created | `order_creation_error` (`paymentReference`, `sessionId`, `errors`) | none | — . The money may be taken and nothing in this connector creates the order or refunds automatically; handle it in your operations (§7) |
| Order verification timed out | `order_verification_timeout` → call `retryOrderVerification()` | unknown until verified | — |

**Retries and multiple Payments.** An attempt adds a Payment to the cart unless the cart's open
Payment qualifies for reuse — same amount, currency and configuration, PaymentIntent still
confirmable (§3.10). Checkout refuses to add a Payment to a cart that already references an **approved** one
(`cart_with_existing_payment`, `external`; confirmed 2026-10, https://docs.commercetools.com/checkout/messages).
Which transaction states Checkout counts as "approved" is not documented (§7); a retry that hits this
Message after an earlier attempt is the symptom to look for.

**Who does what next.** Exactly §5.3 "The connector by itself" — webhooks keep recording transactions,
and the two `paymentState` writers apply. Left to the host on A–C: the confirmation page (from
`order.id`), handling `order_creation_error`, and — for rails that settle later — reading the order's
`paymentState` or the Payment (§3.5) before fulfilment. Backend notifications are available as Checkout
Events (`CheckoutPaymentAuthorized`, `CheckoutPaymentCharged`, `CheckoutOrderCreationFailed`, …) through
a Subscription (`external`; confirmed 2026-10, https://docs.commercetools.com/checkout/checkout-events);
whether Checkout emits them for payments processed by this connector was not tested (§7).

---

## 6. Running a host locally against a deployed unit

| Need | What to do | Source |
| --- | --- | --- |
| Call the processor from `http://localhost:…` | Nothing for sessions routes — CORS is `origin: '*'` with `X-Session-ID`, `x-express-checkout`, `x-express-customer-session` allowed | `processor/src/server/server.ts:40-43` |
| Path F (`POST /express-config`) locally | Add your exact origin (scheme, host, port — e.g. `http://localhost:3000`, or the tunnel origin) to `ALLOWED_ORIGINS`, comma-separated; this needs a processor restart (§2.4) | `cors.ts:24-31`; `connect.yaml:93-95` |
| Payment Element over HTTP | Possible in test mode: "You can test your integration without using HTTPS … enable it when you're ready to accept live charges" | `external`; confirmed 2026-10, https://docs.stripe.com/security/guide |
| Wallets (Express, Apple Pay, Google Pay) | HTTPS is required "in development and in production"; use a tunnel such as ngrok, and **register the tunnel's domain** in your Stripe sandbox | `external`; confirmed 2026-10, https://docs.stripe.com/elements/express-checkout-element/accept-a-payment?payment-ui=elements, https://docs.stripe.com/payments/payment-methods/pmd-registration?dashboard-or-api=api |
| Apple Pay testing | Supported Safari/device with an active card in Apple Wallet; test keys turn a real card into a test token; or set `paymentMethods.applePay: 'always'` to drop the saved-card requirement | `external`; confirmed 2026-10, https://docs.stripe.com/elements/express-checkout-element/accept-a-payment?payment-ui=elements. Note `paymentMethods` is **not** among the Express options this enabler forwards (`…-mock.ts:21-28`) |
| Google Pay testing | Supported browser, registered domain, a card in Google Pay. (The connector's README says Google Pay needs no domain setup, `enabler/README.md:35`; Stripe's current testing guidance says to be on a registered domain) | same source |
| Redirect methods locally | The return goes to the **deployed** `MERCHANT_RETURN_URL`, not to localhost, unless the session principal supplies one (§5.4) | `stripe-payment.service.ts:779` |
| Paths A–C from `localhost` | The Application's **Origin URLs** must admit your page. The documented pattern requires a dotted host with a TLD (`([a-zA-Z0-9-]+\.)+[a-zA-Z]{2,}`), so `http://localhost:3000` does not match it as written: use the **allow all origins** toggle on a test Application ("recommended for test purposes only"), or a tunnel domain listed explicitly. Prefer a separate test Application over loosening the production one | `external`; confirmed 2026-10, https://docs.commercetools.com/checkout/connectors-and-applications. That `localhost` is rejected is read from the pattern, not tested |
| Paths A–C: redirects locally | The shopper returns to the Application's Payment return URL or the deployment's `MERCHANT_RETURN_URL` — not to localhost unless one of those points there (§5.4.1). Re-enter `checkoutFlow` with `paymentReference` on that page | §5.4.1 |
| Paths A–C: seeing what happens | `logInfo: true, logWarn: true, logError: true` print every Checkout Message to the console; the enabler's processor calls (§3.7–3.11) appear in the network tab | `external`; confirmed 2026-10, https://docs.commercetools.com/checkout/browser-sdk |
| Webhooks | Nothing to do — Stripe calls the deployed processor | `processor/README.md:322-346` |
| Test cards | `4242 4242 4242 4242` succeeds; `4000 0000 0000 0002` → `card_declined`/`generic_decline`; `4000 0000 0000 9995` → `insufficient_funds`; `4000 0000 0000 3220` requires 3DS | `external`; confirmed 2026-10, https://docs.stripe.com/testing |
| Test vs live | Decided by the publishable key: a key containing `_test_` makes the enabler report `test` | `…-mock.ts:172` |
| Deployed URLs | §2.2 | — |
| A working reference | `enabler/index.html` + `enabler/dev-utils/{session,checkout}.js` drive drop-in and Express directly. They fetch an **admin token in the browser** (`dev-utils/session.js:3-27`) — development only; move every commercetools call to your backend | — |
| Alternatively, run the processor locally | `docker compose up` starts jwt-server :9000, enabler :3000, processor :8080 (`docker-compose.yaml`); webhooks then need `stripe listen` or a tunnel | `processor/README.md:646-654` |

---

## 7. Not covered

- **Session lifetime and state rules** — the only evidence is an example `expiryAt` one hour
  after `createdAt`; no policy is documented on the pages read (reuse while valid, and a new session
  after `expired_session`, are documented — §3.2.1). What the processor answers for an
  expired session (status code, message) is defined inside `@commercetools/connect-payments-sdk` 1.2.2,
  which is not installed in this repository. The Sessions API's error responses, and its call for
  attaching a cart to an existing session (Express on a product page, §4.11), were not found on the pages read.
- **Paths D–F: whether `metadata.processorUrl` / `allowedPaymentMethods` are required or validated** by the
  Sessions API or the SDK's session hook for a non-Checkout session, and whether `applicationKey` is
  required there — this repository sends the former and omits the latter; not confirmed against the
  current Sessions API. (The Checkout Session body for A–C is documented — §3.2.1.) This repository's
  own code never reads them (§4.14).
- **Whether Express without commercetools Checkout (paths E, F) is a supported use** — only this
  repository's README describes it, so its §1 status is `unknown`. No platform page read mentions it,
  and no direct host (D, E or F) is recorded as observed.
- **Where Checkout takes the principal `merchantReturnUrl` from.** That it supplies a valid one on path A
  is observed (§5.4.1); whether the source is the Application's Payment return URL is stated nowhere.
  For paths D–F, how a host sets it at all (and whether `metadata.merchantReturnUrl` maps to it).
- **How Checkout maps the enabler's signals onto Messages**, beyond drop-in `onError` → `payment_failed`
  (§4.12): the drop-in's pending `onComplete({ isSuccess: false })` (bank transfer), Express's two
  `onComplete` calls on success (§4.7), Express's `CANCEL` error and its generic confirm error (§4.6).
- **Which Message strings the current Browser SDK emits** for payment-integration events —
  `payment_method_*` / `payment_completed` (SDK page samples) or `payment_integration_*` (Messages
  reference) (§4.12).
- **Whether Checkout passes its `locale` to this enabler** (§4.8, §4.10).
- **Which Express payment methods Merchant Center lists for this connector** when adding an Express
  Payments integration (§2.5).
- **Express mount details:** how Checkout maps a rejected host callback or a shipping item's
  `isSelected` onto the enabler, and how to remove mounted Express buttons (no `unmount` is documented).
- **What Checkout counts as an "approved" Payment** for `cart_with_existing_payment` (§5.5).
- **What to do after `order_creation_error`** — commercetools documents the Message, not a recovery
  procedure; this connector does not refund or create orders by itself (§5.5).
- **Whether Checkout Events** (`CheckoutPaymentCharged`, …) are emitted for payments processed by this
  connector, which records transactions from Stripe webhooks rather than through Checkout (§5.5).
- **How `getPaymentAmount` computes the amount** (gross vs net, gift cards, discounts) — SDK internals.
- **Whether an empty `shipping.name` is rejected** by Stripe when the cart's shipping address has no names.
- **Three-decimal currencies** and other zero/three-decimal edge cases of passing `centAmount` unconverted to Stripe.
- **Connect specifics:** the field that holds each application's URL in a Deployment, the URL form
  of an `assets` application, whether assets are served with CORS headers, whether secured
  configuration values are returned, the OAuth scope needed to read a Deployment, and whether editing
  configuration in Merchant Center redeploys automatically.
- **Whether hosting the Apple Pay domain-association file (`/applePayConfig`) is still needed** with
  Stripe's current payment-method-domain registration.
- **Full `OrderFromCartDraft` fields** and cart prerequisites for order creation (shipping method,
  addresses, email) — commercetools' own rules, not this connector's.
- **The exact `PaymentState` enum and `OrderChangePaymentStateAction` shape** beyond the values this
  code writes (`Paid`, `Pending`, `Failed`).
- **The cart update action for the customer email** in `onPaymentSubmit` — the reference
  implementation leaves it empty (`enabler/index.html:751-753`).
- **Payment Only mode with this connector** — the SDK side is documented (§4.10), but the repository
  never mentions Payment Only and nothing here records it being exercised; status in §1 rests on
  platform documentation only.
- **Which Express wallets can end in `pending` or redirect** (PayPal, Klarna, Amazon Pay inside the Express Checkout Element) — not established by the code.
- **Behaviour of `pi_first` with Express**, beyond the fact that Express skips it (`…-mock.ts:125-135`).
- **Shipping-change time limits** in the Express sheet (only the 1-second `click` limit was found).
- **Multi-shipping (`shippingMode: Multiple`) carts** — not exercised by this code.
- **Gift cards, discounts codes changed during Express, and store-scoped carts** — no evidence either way.
