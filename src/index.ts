import { createHmac, timingSafeEqual } from "node:crypto";
import {
  Environment,
  Paddle,
  type Price,
  type Product,
  type TaxCategory,
} from "@paddle/paddle-node-sdk";

/*
 * One file on purpose. Any relative import has to name its extension for Node
 * (`./errors.js`), and a bundler compiling this source directly — an app on a
 * dev checkout imports it through tsconfig `paths` — then looks for a file
 * called errors.js that does not exist. With nothing to import, every consumer
 * reads it the same way.
 */

// ---------------------------------------------------------------------------
// Errors

/** The package was given something it cannot work with: a missing key, a live key for sandbox. */
export class PaddleConfigError extends Error {
  override name = "PaddleConfigError";
}

/** A webhook whose signature does not match its body and the secret. Nothing in it is to be believed. */
export class WebhookSignatureError extends Error {
  override name = "WebhookSignatureError";
}

/** A price or plan asked for in a shape the catalogue refuses — said in a sentence an admin can act on. */
export class CatalogError extends Error {
  override name = "CatalogError";
}

// ---------------------------------------------------------------------------
// Catalogue

/** How often a price bills. Paddle allows more; a plan is sold by the month or the year. */
export type BillingInterval = "month" | "year";

/** One price of one plan, as the catalogue shows it — plain data, safe to hand to a page. */
export interface PlanPrice {
  id: string;
  planId: string;
  productId: string;
  interval: BillingInterval;
  /** In the currency's lowest unit: 900 is $9.00, and 900 is ¥900. */
  amount: number;
  currency: string;
  /** Days free before the first charge, or null for none. */
  trialDays: number | null;
  createdAt: string;
}

/** A plan's product in Paddle, with the prices that are on offer. */
export interface PlanCatalogue {
  planId: string;
  productId: string;
  name: string;
  prices: PlanPrice[];
}

/** What an app knows about one of its plans. */
export interface PlanInfo {
  id: string;
  name: string;
  description?: string | null;
}

export interface NewPrice {
  interval: BillingInterval;
  /** In the currency's lowest unit. */
  amount: number;
  /** ISO 4217. Defaults to USD. */
  currency?: string;
  trialDays?: number | null;
}

interface CatalogOptions {
  planKey: string;
  taxCategory: TaxCategory;
}

/* A product list is short — one product per plan — but the walk is capped all
   the same, so an account full of unrelated products cannot turn a page load
   into an unbounded crawl. */
const MOST_PRODUCTS = 500;
const MOST_TRIAL_DAYS = 365;

const LABEL: Record<BillingInterval, string> = { month: "Monthly", year: "Yearly" };

function planIdOf(customData: unknown, planKey: string): string | null {
  if (!customData || typeof customData !== "object") return null;

  const value = (customData as Record<string, unknown>)[planKey];

  return typeof value === "string" && value ? value : null;
}

function toPlanPrice(price: Price, planId: string): PlanPrice | null {
  const interval = price.billingCycle?.interval;

  /* One-off prices, and cycles other than a single month or year, are not
     something this catalogue made; they are left alone rather than misread. */
  if ((interval !== "month" && interval !== "year") || price.billingCycle?.frequency !== 1)
    return null;

  const trial = price.trialPeriod;

  return {
    id: price.id,
    planId,
    productId: price.productId,
    interval,
    amount: Number(price.unitPrice.amount),
    currency: price.unitPrice.currencyCode,
    /* Trials this catalogue makes are counted in days; one written elsewhere in
       weeks or months is converted roughly rather than dropped. */
    trialDays: !trial
      ? null
      : trial.frequency * ({ day: 1, week: 7, month: 30, year: 365 } as const)[trial.interval],
    createdAt: price.createdAt,
  };
}

/** Every product that belongs to a plan, with its active prices. Newest price first within a plan. */
async function readCatalogue(paddle: Paddle, options: CatalogOptions): Promise<PlanCatalogue[]> {
  const out: PlanCatalogue[] = [];
  let seen = 0;

  for await (const product of paddle.products.list({
    status: ["active"],
    include: ["prices"],
    perPage: 200,
  })) {
    if (++seen > MOST_PRODUCTS) break;

    const planId = planIdOf(product.customData, options.planKey);
    if (!planId) continue;

    const prices = (product.prices ?? [])
      .filter((price) => price.status === "active")
      .map((price) => toPlanPrice(price, planId))
      .filter((price): price is PlanPrice => price !== null)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    out.push({ planId, productId: product.id, name: product.name, prices });
  }

  return out;
}

async function findProduct(
  paddle: Paddle,
  planId: string,
  options: CatalogOptions,
): Promise<Product | null> {
  let seen = 0;

  for await (const product of paddle.products.list({ status: ["active"], perPage: 200 })) {
    if (++seen > MOST_PRODUCTS) break;
    if (planIdOf(product.customData, options.planKey) === planId) return product;
  }

  return null;
}

/**
 * The plan's product in Paddle: found by the plan id in its custom data, or
 * made. A found product takes the plan's current name and description, so a
 * plan renamed in the app is renamed at checkout too.
 */
async function ensureProduct(
  paddle: Paddle,
  plan: PlanInfo,
  options: CatalogOptions,
): Promise<Product> {
  const existing = await findProduct(paddle, plan.id, options);
  const description = plan.description?.trim() || null;

  if (!existing) {
    return paddle.products.create({
      name: plan.name,
      description,
      taxCategory: options.taxCategory,
      customData: { [options.planKey]: plan.id },
    });
  }

  if (existing.name !== plan.name || (existing.description ?? null) !== description) {
    return paddle.products.update(existing.id, { name: plan.name, description });
  }

  return existing;
}

/** Checked here so the refusal is a sentence, not whatever the API says about a malformed body. */
function checkNewPrice(input: NewPrice): Required<NewPrice> {
  if (input.interval !== "month" && input.interval !== "year") {
    throw new CatalogError("A price bills monthly or yearly.");
  }
  if (!Number.isInteger(input.amount) || input.amount <= 0) {
    throw new CatalogError(
      "The amount is a whole number above 0, in the currency's smallest unit (900 is $9.00).",
    );
  }

  const currency = (input.currency ?? "USD").toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency))
    throw new CatalogError(`"${input.currency}" is not a currency code.`);

  const trialDays = input.trialDays ?? null;
  if (
    trialDays !== null &&
    (!Number.isInteger(trialDays) || trialDays < 1 || trialDays > MOST_TRIAL_DAYS)
  ) {
    throw new CatalogError(`A trial is 1 to ${MOST_TRIAL_DAYS} days, or none.`);
  }

  return { interval: input.interval, amount: input.amount, currency, trialDays };
}

/**
 * A new price for a plan, making the plan's product first if it has none.
 *
 * There is no editing a price's amount. People already paying it keep paying
 * it; a different amount is a new price, and the old one is archived — which
 * stops new checkouts, not existing subscriptions.
 */
async function addPrice(
  paddle: Paddle,
  plan: PlanInfo,
  input: NewPrice,
  options: CatalogOptions,
): Promise<PlanPrice> {
  const price = checkNewPrice(input);
  const product = await ensureProduct(paddle, plan, options);

  const created = await paddle.prices.create({
    productId: product.id,
    name: LABEL[price.interval],
    description: `${plan.name}, ${LABEL[price.interval].toLowerCase()}`,
    unitPrice: { amount: String(price.amount), currencyCode: price.currency as never },
    billingCycle: { interval: price.interval, frequency: 1 },
    trialPeriod: price.trialDays ? { interval: "day", frequency: price.trialDays } : null,
    /* On the price as well as the product: a webhook's subscription item
       carries its price, and the plan should not depend on whether the
       product came along with it. */
    customData: { [options.planKey]: plan.id },
  });

  const mapped = toPlanPrice(created, plan.id);
  if (!mapped) throw new CatalogError("Paddle answered with a price this catalogue cannot read.");

  return mapped;
}

/**
 * Stops a price being offered. Subscriptions on it carry on.
 *
 * Refuses a price that is not one of a plan's, so an app's admin screen cannot
 * be used to archive whatever else lives in the Paddle account.
 */
async function archivePrice(
  paddle: Paddle,
  priceId: string,
  options: CatalogOptions,
): Promise<void> {
  const price = await paddle.prices.get(priceId);

  if (!planIdOf(price.customData, options.planKey)) {
    throw new CatalogError("That price does not belong to any plan.");
  }

  if (price.status !== "archived") await paddle.prices.archive(priceId);
}

// ---------------------------------------------------------------------------
// Signed custom data

/*
 * Paddle signs every webhook, and that says the event came from Paddle. It
 * does not say the custom data in it came from the app: anything that can
 * open a checkout on the account — Paddle.js with the public client token, the
 * dashboard — can write custom data. So the app signs its own, with a secret
 * Paddle never sees, and believes only what still carries its signature when
 * it comes back.
 */

const SIGNATURE_KEY = "sig";

function canonical(fields: Record<string, string>): string {
  return Object.keys(fields)
    .filter((key) => key !== SIGNATURE_KEY)
    .sort()
    .map((key) => `${key}=${fields[key]}`)
    .join("\n");
}

function hmac(secret: string, text: string): string {
  return createHmac("sha256", secret).update(`v1\n${text}`).digest("base64url");
}

/** Custom data with the app's signature added, as `sig`. Values must be strings. */
export function signCustomData(
  fields: Record<string, string>,
  secret: string,
): Record<string, string> {
  if (!secret) throw new PaddleConfigError("A secret is required to sign custom data.");

  const clean = Object.fromEntries(Object.entries(fields).filter(([key]) => key !== SIGNATURE_KEY));

  return { ...clean, [SIGNATURE_KEY]: hmac(secret, canonical(clean)) };
}

/**
 * The fields of custom data the app signed, or null if the signature is
 * missing or wrong — including when any field was changed, added or dropped.
 */
export function verifyCustomData(
  customData: unknown,
  secret: string | undefined,
): Record<string, string> | null {
  if (!secret || !customData || typeof customData !== "object") return null;

  const data = customData as Record<string, unknown>;
  const given = data[SIGNATURE_KEY];
  if (typeof given !== "string") return null;

  const fields: Record<string, string> = {};
  for (const [key, value] of Object.entries(data)) {
    if (key === SIGNATURE_KEY) continue;
    if (typeof value !== "string") return null;
    fields[key] = value;
  }

  const expected = Buffer.from(hmac(secret, canonical(fields)));
  const actual = Buffer.from(given);

  return expected.length === actual.length && timingSafeEqual(expected, actual) ? fields : null;
}

// ---------------------------------------------------------------------------
// Webhooks

export type SubscriptionStatus = "active" | "trialing" | "past_due" | "paused" | "canceled";

/**
 * A subscription event, reduced to what an app with plans acts on: whose it is,
 * which plan, and until when that plan is paid for.
 */
export interface SubscriptionEvent {
  kind: "subscription";
  /** Paddle's event id. Unique per delivery attempt's event, so it is what a retry is recognised by. */
  eventId: string;
  eventType: string;
  /**
   * When Paddle says it happened. Webhooks can arrive out of order, and an
   * older one must not undo a newer one — keep the newest you have acted on
   * per subscription and ignore anything before it.
   */
  occurredAt: string;
  subscriptionId: string;
  customerId: string;
  status: SubscriptionStatus;
  /** The plan the subscription is on, from the custom data on its price or product; null if neither names one. */
  planId: string | null;
  priceId: string | null;
  /**
   * Until when the plan is paid for, or null when access should end now.
   *
   * The end of the current billing period for `active` and `trialing`, and for
   * `past_due` too, while Paddle retries the card. A subscription scheduled to
   * cancel still runs to the end of what was paid. `paused` and `canceled` are
   * null.
   */
  paidUntil: string | null;
  /** When a scheduled cancellation takes effect, if one is scheduled. */
  cancelsAt: string | null;
  /**
   * The subscription's own custom data — where an app puts its user's id when
   * it opens the checkout, so the event can be matched back to the account.
   */
  customData: Record<string, unknown>;
  /**
   * The custom data the app signed, verified with `customDataSecret`; null if
   * there is no secret, no signature, or it does not match. Act on this, not
   * on `customData`.
   */
  signed: Record<string, string> | null;
}

/**
 * A payment — the first one of a checkout, or a renewal. `transaction.paid`
 * and `transaction.completed` both arrive for one payment; the transaction id
 * is what records it once.
 */
export interface TransactionEvent {
  kind: "transaction";
  eventId: string;
  eventType: string;
  occurredAt: string;
  transactionId: string;
  status: string;
  /** `web` or `api` for a checkout; `subscription_recurring` for a renewal; others for changes. */
  origin: string;
  subscriptionId: string | null;
  customerId: string | null;
  /** The total charged, in the currency's lowest unit, as Paddle writes it. */
  total: string | null;
  currency: string;
  customData: Record<string, unknown>;
  /** As on SubscriptionEvent. Renewals carry the subscription's custom data, so they carry the signature too. */
  signed: Record<string, string> | null;
}

/** Any event this module does not reduce. Acknowledge it and move on. */
export interface OtherEvent {
  kind: "other";
  eventId: string;
  eventType: string;
  occurredAt: string;
}

export type BillingEvent = SubscriptionEvent | TransactionEvent | OtherEvent;

/* Payments. `paid` is when the money is taken; `completed` follows once Paddle has done its own processing. */
const TRANSACTION_EVENTS = new Set(["transaction.paid", "transaction.completed"]);

/* The subscription.* events whose data is a subscription. */
const SUBSCRIPTION_EVENTS = new Set([
  "subscription.created",
  "subscription.activated",
  "subscription.updated",
  "subscription.trialing",
  "subscription.past_due",
  "subscription.paused",
  "subscription.resumed",
  "subscription.canceled",
  "subscription.imported",
]);

interface SubscriptionData {
  id: string;
  status: SubscriptionStatus;
  customerId: string;
  currentBillingPeriod: { endsAt: string } | null;
  scheduledChange: { action: string; effectiveAt: string } | null;
  customData: unknown;
  items: {
    status: string;
    recurring: boolean;
    price: { id: string; customData: unknown } | null;
    product: { customData: unknown } | null;
  }[];
}

function reduceSubscription(
  event: { eventId: string; eventType: string; occurredAt: string; data: SubscriptionData },
  planKey: string,
  customDataSecret?: string,
): SubscriptionEvent {
  const subscription = event.data;

  /* The first recurring item that names a plan. An app sells one plan per
     subscription; add-ons, if there are any, name none. */
  const item =
    subscription.items.find(
      (entry) =>
        entry.recurring &&
        (planIdOf(entry.price?.customData, planKey) ||
          planIdOf(entry.product?.customData, planKey)),
    ) ??
    subscription.items.find((entry) => entry.recurring) ??
    null;

  const planId = item
    ? (planIdOf(item.price?.customData, planKey) ?? planIdOf(item.product?.customData, planKey))
    : null;
  const scheduled = subscription.scheduledChange;
  const running =
    subscription.status === "active" ||
    subscription.status === "trialing" ||
    subscription.status === "past_due";

  return {
    kind: "subscription",
    eventId: event.eventId,
    eventType: event.eventType,
    occurredAt: event.occurredAt,
    subscriptionId: subscription.id,
    customerId: subscription.customerId,
    status: subscription.status,
    planId,
    priceId: item?.price?.id ?? null,
    paidUntil: running ? (subscription.currentBillingPeriod?.endsAt ?? null) : null,
    cancelsAt: scheduled?.action === "cancel" ? scheduled.effectiveAt : null,
    customData:
      subscription.customData && typeof subscription.customData === "object"
        ? { ...(subscription.customData as Record<string, unknown>) }
        : {},
    signed: verifyCustomData(subscription.customData, customDataSecret),
  };
}

interface TransactionData {
  id: string;
  status: string;
  origin: string;
  subscriptionId: string | null;
  customerId: string | null;
  currencyCode: string;
  customData: unknown;
  details: { totals: { total: string } | null } | null;
}

function reduceTransaction(
  event: { eventId: string; eventType: string; occurredAt: string; data: TransactionData },
  customDataSecret?: string,
): TransactionEvent {
  const transaction = event.data;

  return {
    kind: "transaction",
    eventId: event.eventId,
    eventType: event.eventType,
    occurredAt: event.occurredAt,
    transactionId: transaction.id,
    status: transaction.status,
    origin: transaction.origin,
    subscriptionId: transaction.subscriptionId ?? null,
    customerId: transaction.customerId ?? null,
    total: transaction.details?.totals?.total ?? null,
    currency: transaction.currencyCode,
    customData:
      transaction.customData && typeof transaction.customData === "object"
        ? { ...(transaction.customData as Record<string, unknown>) }
        : {},
    signed: verifyCustomData(transaction.customData, customDataSecret),
  };
}

/**
 * Checks a webhook's signature and reads it.
 *
 * `rawBody` must be the request body exactly as it arrived — read it as text
 * before anything parses it. A body that went through JSON.parse and back is a
 * different string, and its signature will not match.
 *
 * Throws WebhookSignatureError for a signature that does not match; answer
 * that with a 4xx and act on nothing in it.
 */
async function readWebhook(
  paddle: Paddle,
  rawBody: string,
  signature: string | null | undefined,
  secret: string,
  planKey: string,
  customDataSecret?: string,
): Promise<BillingEvent> {
  if (!signature)
    throw new WebhookSignatureError("The request carries no Paddle-Signature header.");

  let event;

  try {
    event = await paddle.webhooks.unmarshal(rawBody, secret, signature);
  } catch (error) {
    throw new WebhookSignatureError(
      `The webhook's signature does not match: ${(error as Error).message}`,
    );
  }

  if (SUBSCRIPTION_EVENTS.has(event.eventType)) {
    return reduceSubscription(
      event as unknown as Parameters<typeof reduceSubscription>[0],
      planKey,
      customDataSecret,
    );
  }

  if (TRANSACTION_EVENTS.has(event.eventType)) {
    return reduceTransaction(
      event as unknown as Parameters<typeof reduceTransaction>[0],
      customDataSecret,
    );
  }

  return {
    kind: "other",
    eventId: event.eventId,
    eventType: event.eventType,
    occurredAt: event.occurredAt,
  };
}

// ---------------------------------------------------------------------------
// Buying

/** What `checkout()` hands the browser: Paddle.js opens the checkout for this transaction. */
export interface CheckoutSession {
  transactionId: string;
  customerId: string;
}

/**
 * The Paddle customer for an email address, made the first time.
 *
 * One customer per address is what Paddle itself enforces, so looking up
 * before creating is what keeps a second checkout from failing on a
 * duplicate.
 */
async function customerFor(paddle: Paddle, email: string, name?: string | null): Promise<string> {
  const address = email.trim().toLowerCase();

  for await (const customer of paddle.customers.list({ email: [address], perPage: 1 })) {
    return customer.id;
  }

  return (await paddle.customers.create({ email: address, name: name ?? null })).id;
}

/**
 * A draft transaction for one price, made on the server.
 *
 * Made here rather than by Paddle.js from a price id, because the custom data
 * travels with it: the app's user id is written by the server, so no page can
 * open a checkout that credits somebody else's account. Paddle copies it onto
 * the subscription the checkout creates, which is how a webhook finds the user.
 */
async function openCheckout(
  paddle: Paddle,
  input: {
    priceId: string;
    email: string;
    name?: string | null;
    customData: Record<string, string>;
  },
): Promise<CheckoutSession> {
  const customerId = await customerFor(paddle, input.email, input.name);
  const transaction = await paddle.transactions.create({
    items: [{ priceId: input.priceId, quantity: 1 }],
    customerId,
    customData: input.customData,
  });

  return { transactionId: transaction.id, customerId };
}

// ---------------------------------------------------------------------------
// The client

export type PaddleEnvironment = "sandbox" | "production";

export interface PaddleBillingInit {
  /** A server-side API key. Sandbox keys contain `_sdbx`. */
  apiKey: string;
  /**
   * Which Paddle to talk to. Read from the key when left out — a sandbox key
   * says so in its name — and checked against it when given, because a live
   * key sent to sandbox (or the other way) fails with a 401 that says nothing
   * about why.
   */
  environment?: PaddleEnvironment;
  /** The notification destination's secret key, for `webhook()`. */
  webhookSecret?: string;
  /**
   * The app's own secret for signing custom data — never given to Paddle.
   * With it, `checkout()` signs the custom data it writes, and every event
   * reports what still carries that signature as `signed`.
   */
  customDataSecret?: string;
  /**
   * The custom-data key that ties a Paddle product and price to a plan of the
   * app. Defaults to `plan_id`.
   */
  planKey?: string;
  /** Tax category for products this package creates. Defaults to `saas`. */
  taxCategory?: TaxCategory;
}

function environmentOf(apiKey: string, asked?: PaddleEnvironment): PaddleEnvironment {
  const fromKey: PaddleEnvironment | null = apiKey.includes("_sdbx")
    ? "sandbox"
    : apiKey.includes("_live")
      ? "production"
      : null;

  if (asked && fromKey && asked !== fromKey) {
    throw new PaddleConfigError(
      `This is a ${fromKey} API key, and the environment is set to ${asked}.`,
    );
  }

  return asked ?? fromKey ?? "production";
}

/**
 * Paddle Billing for an app whose users are on plans.
 *
 * A factory, like the other `@ecosy` tokens: the configuration is captured
 * here and the class it returns takes no arguments, so it drops into an
 * injector.
 *
 * ```ts
 * export const Billing = PaddleBilling({
 *   apiKey: process.env.PADDLE_API_KEY!,
 *   webhookSecret: process.env.PADDLE_WEBHOOK_SECRET,
 * });
 *
 * const billing = new Billing();
 * await billing.addPrice({ id: "pro", name: "Pro" }, { interval: "month", amount: 900 });
 * const catalogue = await billing.catalogue();
 * ```
 *
 * The plan is the app's; Paddle holds its prices. Each plan is one Paddle
 * product, found by `custom_data.plan_id`, so there is nothing to keep in step
 * in the app's own database.
 */
export function PaddleBilling(init: PaddleBillingInit) {
  if (!init.apiKey) throw new PaddleConfigError("A Paddle API key is required.");

  const environment = environmentOf(init.apiKey, init.environment);
  const options: CatalogOptions = {
    planKey: init.planKey ?? "plan_id",
    taxCategory: init.taxCategory ?? "saas",
  };
  let client: Paddle | null = null;

  return class Billing {
    /** Which Paddle this talks to — worth showing wherever prices are edited. */
    static readonly environment: PaddleEnvironment = environment;
    readonly environment: PaddleEnvironment = environment;

    /** The SDK client, for anything this package does not wrap. */
    get paddle(): Paddle {
      return (client ??= new Paddle(init.apiKey, {
        environment: environment === "sandbox" ? Environment.sandbox : Environment.production,
      }));
    }

    /** Every plan that has a product in Paddle, with the prices on offer. */
    catalogue() {
      return readCatalogue(this.paddle, options);
    }

    /** One plan's prices on offer, newest first; empty if the plan has no product yet. */
    async prices(planId: string) {
      return (await this.catalogue()).find((entry) => entry.planId === planId)?.prices ?? [];
    }

    /** The plan's product, made if missing and renamed if the plan was. */
    product(plan: PlanInfo) {
      return ensureProduct(this.paddle, plan, options);
    }

    /** A new price for a plan. To change an amount, add the new price and archive the old one. */
    addPrice(plan: PlanInfo, price: NewPrice) {
      return addPrice(this.paddle, plan, price, options);
    }

    /** Stops offering a price. Subscriptions already on it carry on. */
    archivePrice(priceId: string) {
      return archivePrice(this.paddle, priceId, options);
    }

    /**
     * A checkout for one of a plan's prices, for one of the app's users.
     *
     * `customData` is written onto the transaction and, by Paddle, onto the
     * subscription it creates; put the app's user id in it. Refuses a price
     * that no plan owns, so a request cannot buy whatever else is in the
     * account.
     */
    async checkout(input: {
      priceId: string;
      email: string;
      name?: string | null;
      customData: Record<string, string>;
    }) {
      const price = await this.paddle.prices.get(input.priceId);

      if (price.status !== "active" || !planIdOf(price.customData, options.planKey)) {
        throw new CatalogError("That price is not on sale.");
      }

      return openCheckout(this.paddle, {
        ...input,
        customData: init.customDataSecret
          ? signCustomData(input.customData, init.customDataSecret)
          : input.customData,
      });
    }

    /**
     * Where a customer manages what they pay for — card, invoices, cancelling.
     * A link to Paddle's own portal, good for a short while; open it, do not
     * store it.
     */
    async portal(customerId: string, subscriptionIds: string[] = []): Promise<string> {
      const session = await this.paddle.customerPortalSessions.create(customerId, subscriptionIds);

      return session.urls.general.overview;
    }

    /**
     * Cancels a subscription at the end of the period already paid for — the
     * customer keeps what they bought, and is not charged again. Returns when
     * that is. Paddle sends `subscription.updated` with the scheduled change,
     * then `subscription.canceled` on the day.
     */
    async cancel(subscriptionId: string): Promise<{ cancelsAt: string | null }> {
      const subscription = await this.paddle.subscriptions.cancel(subscriptionId, {
        effectiveFrom: "next_billing_period",
      });

      return {
        cancelsAt:
          subscription.scheduledChange?.action === "cancel"
            ? subscription.scheduledChange.effectiveAt
            : subscription.canceledAt,
      };
    }

    /** Takes back a cancellation that has not happened yet: the subscription renews as before. */
    async keep(subscriptionId: string): Promise<void> {
      await this.paddle.subscriptions.update(subscriptionId, { scheduledChange: null });
    }

    /**
     * A link to the invoice PDF Paddle issued for a payment. Short-lived —
     * redirect to it, do not store it. The app checks the payment is the
     * caller's before asking.
     */
    async invoiceUrl(transactionId: string): Promise<string> {
      return (
        await this.paddle.transactions.getInvoicePDF(transactionId, { disposition: "attachment" })
      ).url;
    }

    /**
     * A webhook, checked and read. See `SubscriptionEvent` for what an app does
     * with one; anything else comes back as `kind: "other"`.
     */
    webhook(rawBody: string, signature: string | null | undefined) {
      if (!init.webhookSecret)
        throw new PaddleConfigError("webhookSecret is not set, so no webhook can be checked.");

      return readWebhook(
        this.paddle,
        rawBody,
        signature,
        init.webhookSecret,
        options.planKey,
        init.customDataSecret,
      );
    }
  };
}
