import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { PaddleBilling, PaddleConfigError, WebhookSignatureError, signCustomData, verifyCustomData } from "../dist/index.js";

const SECRET = "pdl_ntfset_test_secret";
const ORDERS = "app-order-secret";
const Billing = PaddleBilling({ apiKey: "pdl_sdbx_apikey_test", webhookSecret: SECRET, customDataSecret: ORDERS });
const billing = new Billing();

/* Signed the way Paddle signs: HMAC-SHA256 of `${ts}:${body}`, in `ts=…;h1=…`. */
function sign(body, secret = SECRET, ts = Math.floor(Date.now() / 1000)) {
  const h1 = createHmac("sha256", secret).update(`${ts}:${body}`).digest("hex");
  return `ts=${ts};h1=${h1}`;
}

const at = "2026-09-22T06:00:00.000000Z";

function subscriptionEvent(type, overrides = {}, item = {}) {
  return JSON.stringify({
    event_id: "evt_01test",
    event_type: type,
    occurred_at: at,
    notification_id: "ntf_01test",
    data: {
      id: "sub_01test",
      status: "active",
      customer_id: "ctm_01test",
      address_id: "add_01test",
      business_id: null,
      currency_code: "USD",
      created_at: at,
      updated_at: at,
      started_at: at,
      first_billed_at: at,
      next_billed_at: "2026-10-22T06:00:00.000000Z",
      paused_at: null,
      canceled_at: null,
      discount: null,
      collection_mode: "automatic",
      billing_details: null,
      current_billing_period: { starts_at: at, ends_at: "2026-10-22T06:00:00.000000Z" },
      billing_cycle: { interval: "month", frequency: 1 },
      scheduled_change: null,
      items: [{
        status: "active",
        quantity: 1,
        recurring: true,
        created_at: at,
        updated_at: at,
        previously_billed_at: at,
        next_billed_at: "2026-10-22T06:00:00.000000Z",
        trial_dates: null,
        price: {
          id: "pri_01test",
          product_id: "pro_01test",
          description: "Pro, monthly",
          name: "Monthly",
          type: "standard",
          billing_cycle: { interval: "month", frequency: 1 },
          trial_period: null,
          tax_mode: "account_setting",
          unit_price: { amount: "900", currency_code: "USD" },
          unit_price_overrides: [],
          quantity: { minimum: 1, maximum: 1 },
          status: "active",
          custom_data: { plan_id: "pro" },
          import_meta: null,
        },
        product: null,
        ...item,
      }],
      custom_data: { user_id: "42" },
      import_meta: null,
      ...overrides,
    },
  });
}

test("an active subscription: the plan, the account, paid to the end of the period", async () => {
  const body = subscriptionEvent("subscription.activated");
  const event = await billing.webhook(body, sign(body));

  assert.equal(event.kind, "subscription");
  assert.equal(event.planId, "pro");
  assert.equal(event.priceId, "pri_01test");
  assert.equal(event.status, "active");
  assert.equal(event.paidUntil, "2026-10-22T06:00:00.000000Z");
  assert.equal(event.cancelsAt, null);
  assert.deepEqual(event.customData, { user_id: "42" });
  assert.equal(event.eventId, "evt_01test");
  assert.equal(event.occurredAt, at);
});

test("a cancellation scheduled for the period's end keeps what was paid for", async () => {
  const body = subscriptionEvent("subscription.updated", {
    scheduled_change: { action: "cancel", effective_at: "2026-10-22T06:00:00.000000Z", resume_at: null },
  });
  const event = await billing.webhook(body, sign(body));

  assert.equal(event.paidUntil, "2026-10-22T06:00:00.000000Z");
  assert.equal(event.cancelsAt, "2026-10-22T06:00:00.000000Z");
});

test("canceled and paused end access now", async () => {
  for (const status of ["canceled", "paused"]) {
    const body = subscriptionEvent(`subscription.${status}`, { status, current_billing_period: null });
    const event = await billing.webhook(body, sign(body));

    assert.equal(event.status, status);
    assert.equal(event.paidUntil, null);
  }
});

test("past due keeps access while Paddle retries the card", async () => {
  const body = subscriptionEvent("subscription.past_due", { status: "past_due" });
  const event = await billing.webhook(body, sign(body));

  assert.equal(event.paidUntil, "2026-10-22T06:00:00.000000Z");
});

test("the plan is read from the product when the price does not name it", async () => {
  const body = subscriptionEvent("subscription.updated", {}, {
    price: null,
    product: {
      id: "pro_01test", name: "Pro", type: "standard", description: null, tax_category: "saas", image_url: null,
      custom_data: { plan_id: "pro" }, status: "active", created_at: at, updated_at: at, import_meta: null,
    },
  });
  const event = await billing.webhook(body, sign(body));

  assert.equal(event.planId, "pro");
});

test("a body that was changed after signing is refused", async () => {
  const body = subscriptionEvent("subscription.activated");
  const signature = sign(body);

  await assert.rejects(billing.webhook(body.replace('"pro"', '"enterprise"'), signature), WebhookSignatureError);
});

test("a signature made with another secret is refused", async () => {
  const body = subscriptionEvent("subscription.activated");

  await assert.rejects(billing.webhook(body, sign(body, "someone-elses-secret")), WebhookSignatureError);
});

test("no signature at all is refused", async () => {
  const body = subscriptionEvent("subscription.activated");

  await assert.rejects(billing.webhook(body, null), WebhookSignatureError);
});

test("an event this package does not reduce comes back as other", async () => {
  const body = JSON.stringify({
    event_id: "evt_02test", event_type: "customer.created", occurred_at: at, notification_id: "ntf_02test",
    data: {
      id: "ctm_01test", name: null, email: "a@example.test", marketing_consent: false, status: "active",
      custom_data: null, locale: "en", created_at: at, updated_at: at, import_meta: null,
    },
  });
  const event = await billing.webhook(body, sign(body));

  assert.deepEqual(event, { kind: "other", eventId: "evt_02test", eventType: "customer.created", occurredAt: at });
});

test("the environment is read from the key, and a mismatch is refused", () => {
  assert.equal(PaddleBilling({ apiKey: "pdl_sdbx_apikey_x" }).environment, "sandbox");
  assert.equal(PaddleBilling({ apiKey: "pdl_live_apikey_x" }).environment, "production");
  assert.throws(() => PaddleBilling({ apiKey: "pdl_live_apikey_x", environment: "sandbox" }), PaddleConfigError);
  assert.throws(() => PaddleBilling({ apiKey: "" }), PaddleConfigError);
});

test("webhook() without a secret says so", async () => {
  const NoSecret = PaddleBilling({ apiKey: "pdl_sdbx_apikey_x" });

  assert.throws(() => new NoSecret().webhook("{}", "ts=1;h1=x"), PaddleConfigError);
});

test("custom data signed by the app verifies, and any change to it does not", () => {
  const signed = signCustomData({ order_id: "ord_1", user_id: "42" }, ORDERS);

  assert.deepEqual(verifyCustomData(signed, ORDERS), { order_id: "ord_1", user_id: "42" });
  assert.equal(verifyCustomData({ ...signed, user_id: "43" }, ORDERS), null, "a changed field");
  assert.equal(verifyCustomData({ ...signed, extra: "x" }, ORDERS), null, "an added field");
  assert.equal(verifyCustomData({ order_id: "ord_1", sig: signed.sig }, ORDERS), null, "a dropped field");
  assert.equal(verifyCustomData(signed, "another-secret"), null, "another secret");
  assert.equal(verifyCustomData({ order_id: "ord_1", user_id: "42" }, ORDERS), null, "no signature");
  assert.equal(verifyCustomData({ ...signed, user_id: 42 }, ORDERS), null, "a value that is not a string");
  assert.equal(verifyCustomData(signed, undefined), null, "no secret to check with");
});

test("a subscription event reports its signed custom data, and nothing for a forgery", async () => {
  const signed = signCustomData({ order_id: "ord_1", user_id: "42" }, ORDERS);
  const good = subscriptionEvent("subscription.created", { custom_data: signed });
  const forged = subscriptionEvent("subscription.created", { custom_data: { ...signed, user_id: "43" } });
  const plain = subscriptionEvent("subscription.created");

  assert.deepEqual((await billing.webhook(good, sign(good))).signed, { order_id: "ord_1", user_id: "42" });
  assert.equal((await billing.webhook(forged, sign(forged))).signed, null);
  assert.equal((await billing.webhook(plain, sign(plain))).signed, null);
});

function transactionEvent(type, overrides = {}) {
  return JSON.stringify({
    event_id: "evt_03test", event_type: type, occurred_at: at, notification_id: "ntf_03test",
    data: {
      id: "txn_01test", status: type === "transaction.completed" ? "completed" : "paid", customer_id: "ctm_01test",
      address_id: "add_01test", business_id: null, custom_data: null, currency_code: "USD", origin: "web",
      subscription_id: "sub_01test", invoice_id: null, invoice_number: null, collection_mode: "automatic",
      discount_id: null, billing_details: null, billing_period: null, created_at: at, updated_at: at, billed_at: at,
      items: [], details: { tax_rates_used: [], totals: { subtotal: "900", discount: "0", tax: "0", total: "900", credit: "0", balance: "0", grand_total: "900", fee: null, earnings: null, currency_code: "USD" }, adjusted_totals: null, payout_totals: null, adjusted_payout_totals: null, line_items: [] },
      payments: [], checkout: null,
      ...overrides,
    },
  });
}

test("a payment is read with its transaction id, origin, total and signed custom data", async () => {
  const signed = signCustomData({ order_id: "ord_1", user_id: "42" }, ORDERS);
  const body = transactionEvent("transaction.completed", { custom_data: signed, origin: "subscription_recurring" });
  const event = await billing.webhook(body, sign(body));

  assert.equal(event.kind, "transaction");
  assert.equal(event.transactionId, "txn_01test");
  assert.equal(event.origin, "subscription_recurring");
  assert.equal(event.subscriptionId, "sub_01test");
  assert.equal(event.total, "900");
  assert.equal(event.currency, "USD");
  assert.deepEqual(event.signed, { order_id: "ord_1", user_id: "42" });
});
