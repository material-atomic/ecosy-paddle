/* Against Paddle's sandbox. Skipped unless PADDLE_SANDBOX_API_KEY is set.
   Every plan it makes is named test-<random> and archived at the end. */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { CatalogError, PaddleBilling } from "../dist/index.js";

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
