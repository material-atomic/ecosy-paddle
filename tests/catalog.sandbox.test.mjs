/* Against Paddle's sandbox. Skipped unless PADDLE_SANDBOX_API_KEY is set.
   Every plan it makes is named test-<random> and archived at the end. */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { CatalogError, PaddleBilling } from "../dist/index.mjs";

const key = process.env.PADDLE_SANDBOX_API_KEY;
const skip = key ? false : "PADDLE_SANDBOX_API_KEY is not set";

const Billing = key ? PaddleBilling({ apiKey: key }) : null;
const billing = Billing ? new Billing() : null;
const plan = { id: `test-${randomBytes(4).toString("hex")}`, name: "Test plan", description: "Made by @ecosy/paddle's tests" };
const products = new Set();

after(async () => {
  for (const id of products) await billing.paddle.products.update(id, { status: "archived" }).catch(() => {});
});

test("a sandbox key talks to sandbox", { skip }, () => {
  assert.equal(billing.environment, "sandbox");
});

test("a plan with no product has no prices", { skip }, async () => {
  assert.deepEqual(await billing.prices(plan.id), []);
});

test("the first price makes the plan's product, tagged with the plan", { skip }, async () => {
  const monthly = await billing.addPrice(plan, { interval: "month", amount: 900, trialDays: 7 });
  products.add(monthly.productId);

  assert.equal(monthly.planId, plan.id);
  assert.equal(monthly.interval, "month");
  assert.equal(monthly.amount, 900);
  assert.equal(monthly.currency, "USD");
  assert.equal(monthly.trialDays, 7);

  const product = await billing.paddle.products.get(monthly.productId);
  assert.equal(product.customData.plan_id, plan.id);
  assert.equal(product.taxCategory, "saas");
});

test("a second price goes on the same product, and the catalogue shows both, newest first", { skip }, async () => {
  const yearly = await billing.addPrice(plan, { interval: "year", amount: 9000 });
  const prices = await billing.prices(plan.id);

  assert.equal(products.size, 1);
  assert.ok(products.has(yearly.productId));
  assert.deepEqual(prices.map((p) => p.interval), ["year", "month"]);
  assert.equal(prices[0].trialDays, null);
});

test("renaming the plan renames the product", { skip }, async () => {
  const renamed = { ...plan, name: "Test plan, renamed" };
  const product = await billing.product(renamed);

  assert.equal(product.name, "Test plan, renamed");
  assert.equal((await billing.catalogue()).find((entry) => entry.planId === plan.id).name, "Test plan, renamed");
});

test("archiving a price takes it off the catalogue", { skip }, async () => {
  const [newest] = await billing.prices(plan.id);
  await billing.archivePrice(newest.id);

  const left = await billing.prices(plan.id);
  assert.equal(left.length, 1);
  assert.equal(left[0].interval, "month");
});

test("a price that belongs to no plan cannot be archived through this", { skip }, async () => {
  const [product] = products;
  const stray = await billing.paddle.prices.create({
    productId: product,
    description: "Not a plan's price",
    unitPrice: { amount: "100", currencyCode: "USD" },
  });

  await assert.rejects(billing.archivePrice(stray.id), CatalogError);
  await billing.paddle.prices.archive(stray.id);
});

test("bad prices are refused before anything reaches Paddle", { skip }, async () => {
  await assert.rejects(billing.addPrice(plan, { interval: "week", amount: 900 }), CatalogError);
  await assert.rejects(billing.addPrice(plan, { interval: "month", amount: 9.5 }), CatalogError);
  await assert.rejects(billing.addPrice(plan, { interval: "month", amount: 0 }), CatalogError);
  await assert.rejects(billing.addPrice(plan, { interval: "month", amount: 900, currency: "dollars" }), CatalogError);
  await assert.rejects(billing.addPrice(plan, { interval: "month", amount: 900, trialDays: 0 }), CatalogError);
});

test("a checkout is a draft transaction for this price, with the app's user id on it", { skip }, async () => {
  const [price] = await billing.prices(plan.id);
  const email = `checkout-${plan.id}@example.test`;
  const session = await billing.checkout({ priceId: price.id, email, customData: { user_id: "user-42" } });

  assert.match(session.transactionId, /^txn_/);
  assert.match(session.customerId, /^ctm_/);

  const transaction = await billing.paddle.transactions.get(session.transactionId);
  assert.equal(transaction.customData.user_id, "user-42");
  assert.equal(transaction.items[0].price.id, price.id);

  const again = await billing.checkout({ priceId: price.id, email: email.toUpperCase(), customData: { user_id: "user-42" } });
  assert.equal(again.customerId, session.customerId, "the same address is the same customer");
});

test("a checkout for a price no plan owns, or an archived one, is refused", { skip }, async () => {
  const [product] = products;
  const stray = await billing.paddle.prices.create({
    productId: product,
    description: "Not a plan's price",
    unitPrice: { amount: "100", currencyCode: "USD" },
    billingCycle: { interval: "month", frequency: 1 },
  });

  await assert.rejects(billing.checkout({ priceId: stray.id, email: "x@example.test", customData: {} }), CatalogError);
  await billing.paddle.prices.archive(stray.id);

  const archived = (await billing.paddle.prices.list({ productId: [product], status: ["archived"] }).next())
    .find((price) => price.customData?.plan_id === plan.id);
  await assert.rejects(billing.checkout({ priceId: archived.id, email: "x@example.test", customData: {} }), CatalogError);
});

test("the portal is a link to Paddle's own pages for the customer", { skip }, async () => {
  const customer = await billing.paddle.customers.create({ email: `portal-${plan.id}@example.test` });
  const url = await billing.portal(customer.id);

  assert.match(url, /^https:\/\/[^/]*paddle\.(com|io)\//);
});
