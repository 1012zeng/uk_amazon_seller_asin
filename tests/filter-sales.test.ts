import { describe, expect, it } from "vitest";
import type { Sales7dResult } from "../../src/shared/types.js";
import { listingAgeDays, runFilterStage } from "../../src/stages/filter.js";
import { runSales7dStage } from "../../src/stages/sales-7d.js";
import { fixedSales7dWindow } from "../../src/mcp/client.js";
import { runFixture, seedCandidates } from "./helpers.js";

const AS_OF_DATE = "2026-08-13";

function dateForAge(age: number): string {
  return new Date(Date.UTC(2026, 7, 13 - age)).toISOString().slice(0, 10);
}

function addEnrichment(store: ReturnType<typeof runFixture>["store"], asin: string, availableDate: string, fulfillment = "FBA", variations: number | null = 3, childSales: number | null = 100): void {
  store.db.prepare("INSERT INTO enrichments(asin,image_url,child_sales_30d,available_date,fulfillment,variation_count,enriched_at) VALUES(?,'',?,?,?,?, 'x')").run(asin, childSales, availableDate, fulfillment, variations);
  store.db.prepare("UPDATE asin_candidates SET state='mcp_ok' WHERE asin=?").run(asin);
}

function prediction(asin: string, result: "yes" | "No", total: number, complete = true, dailySalesMinimum = 3): Sales7dResult {
  const window = fixedSales7dWindow(AS_OF_DATE);
  return { marketplace: "UK", asin, dataType: "prediction", ...window, dailySalesMinimum, complete, result, days: Array.from({ length: 7 }, (_, index) => ({ date: new Date(Date.UTC(2026, 7, 6 + index)).toISOString().slice(0, 10), sales: index === 0 ? total : 0 })) };
}

describe("second-stage and sales filters", () => {
  it.each([0, 30, 31, 365, 366, 550, 551, 720, 721])("computes fixed UTC age %i", (age) => {
    expect(listingAgeDays(dateForAge(age), AS_OF_DATE)).toBe(age);
  });

  it("keeps 3 variations, rejects 4, keeps child sales 100, and rejects age 721", async () => {
    const { store } = runFixture();
    const asins = seedCandidates(store, 4);
    addEnrichment(store, asins[0]!, dateForAge(31), "FBA", 3, 100);
    addEnrichment(store, asins[1]!, dateForAge(31), "FBA", 4, 100);
    addEnrichment(store, asins[2]!, dateForAge(31), "FBA", 3, 99);
    addEnrichment(store, asins[3]!, dateForAge(721), "FBA", 3, 999);
    store.setStage("enrich", "completed");
    expect(await runFilterStage(store)).toBe(0);
    expect(store.candidates.counts()).toEqual({ filtered_child_sales: 1, filtered_non_sales: 2, retained: 1 });
    expect(store.db.prepare("SELECT asin,filter_reason FROM asin_candidates WHERE state LIKE 'filtered_%' ORDER BY asin").all()).toEqual([
      { asin: asins[1], filter_reason: "variation_count_gt_3" },
      { asin: asins[2], filter_reason: "child_sales_30d_lt_100_for_age_0_365" },
      { asin: asins[3], filter_reason: "age_gt_720" },
    ]);
    expect(store.exports.count()).toBe(1);
    store.close();
  });

  it("applies inclusive 100, 200, and 300 thresholds by age without price segmentation", async () => {
    const { store } = runFixture();
    const asins = seedCandidates(store, 10);
    const cases = [
      { age: 31, price: 699, sales: 100 },
      { age: 365, price: 5000, sales: 100 },
      { age: 366, price: 699, sales: 199 },
      { age: 366, price: 5000, sales: 200 },
      { age: 550, price: 1699, sales: 200 },
      { age: 551, price: 699, sales: 299 },
      { age: 551, price: 5000, sales: 300 },
      { age: 720, price: 699, sales: 300 },
      { age: 31, price: 5000, sales: 99 },
      { age: 721, price: 1699, sales: 999 },
    ];
    cases.forEach(({ age, price, sales }, index) => {
      store.db.prepare("UPDATE store_asin_occurrences SET price_pence=? WHERE asin=?").run(price, asins[index]);
      addEnrichment(store, asins[index]!, dateForAge(age), "FBA", 3, sales);
    });
    store.setStage("enrich", "completed");
    expect(await runFilterStage(store)).toBe(0);
    expect(store.candidates.counts()).toEqual({ filtered_child_sales: 3, filtered_non_sales: 1, retained: 6 });
    expect(store.db.prepare("SELECT asin,filter_reason FROM asin_candidates WHERE state='filtered_child_sales' ORDER BY asin").all()).toEqual([
      { asin: asins[2], filter_reason: "child_sales_30d_lt_200_for_age_366_550" },
      { asin: asins[5], filter_reason: "child_sales_30d_lt_300_for_age_551_720" },
      { asin: asins[8], filter_reason: "child_sales_30d_lt_100_for_age_0_365" },
    ]);
    expect(store.exports.rows().map((row) => row.asin)).toEqual([asins[0], asins[1], asins[3], asins[4], asins[6], asins[7]]);
    store.close();
  });

  it("uses child sales first for 0-30 day products and sends only null sales to the fixed daily-3 API", async () => {
    const { store } = runFixture();
    const asins = seedCandidates(store, 4);
    const cases = [
      { age: 0, price: 699, sales: 99 },
      { age: 30, price: 5000, sales: 100 },
      { age: 15, price: 699, sales: 300 },
      { age: 12, price: 1699, sales: null },
    ];
    cases.forEach(({ age, price, sales }, index) => {
      store.db.prepare("UPDATE store_asin_occurrences SET price_pence=? WHERE asin=?").run(price, asins[index]);
      addEnrichment(store, asins[index]!, dateForAge(age), "FBA", 3, sales);
    });
    store.setStage("enrich", "completed");
    expect(await runFilterStage(store)).toBe(0);
    expect(store.candidates.counts()).toEqual({ filtered_child_sales: 1, retained: 2, sales_pending: 1 });
    const calls: Array<{ asin: string; dailySalesMinimum: number }> = [];
    expect(await runSales7dStage(store, {
      health: async () => undefined,
      sales7d: async (asin, _asOfDate, dailySalesMinimum) => {
        calls.push({ asin, dailySalesMinimum });
        return prediction(asin, "yes", dailySalesMinimum, true, dailySalesMinimum);
      },
    })).toBe(0);
    expect(calls).toEqual([{ asin: asins[3], dailySalesMinimum: 3 }]);
    expect(store.exports.rows().map((row) => [row.asin, row.daily_sales_3_plus])).toEqual([
      [asins[1], null],
      [asins[2], null],
      [asins[3], "yes"],
    ]);
    store.close();
  });

  it("rejects null child sales after day 30", async () => {
    const { store } = runFixture();
    const asins = seedCandidates(store, 3);
    [31, 366, 551].forEach((age, index) => addEnrichment(store, asins[index]!, dateForAge(age), "FBA", 3, null));
    store.setStage("enrich", "completed");
    expect(await runFilterStage(store)).toBe(0);
    expect(store.candidates.counts()).toEqual({ filtered_child_sales: 3 });
    expect(store.sales.counts()).toEqual({});
    store.close();
  });

  it("does not require the 7-day service when every 0-30 day product has child sales", async () => {
    const { store } = runFixture();
    const [asin] = seedCandidates(store, 1);
    addEnrichment(store, asin!, dateForAge(0), "FBA", 3, 100);
    store.setStage("enrich", "completed");
    expect(await runFilterStage(store)).toBe(0);
    expect(await runSales7dStage(store, {
      health: async () => { throw new Error("health must not be called"); },
      sales7d: async () => { throw new Error("sales7d must not be called"); },
    })).toBe(0);
    expect(store.candidates.counts()).toEqual({ retained: 1 });
    store.close();
  });

  it("keeps exact yes, rejects No, and persists the fixed threshold in both ledgers", async () => {
    const { store } = runFixture();
    const asins = seedCandidates(store, 3);
    asins.forEach((asin) => addEnrichment(store, asin, dateForAge(12), "FBA", 3, null));
    store.setStage("enrich", "completed");
    await runFilterStage(store);
    const values = new Map([[asins[0]!, prediction(asins[0]!, "yes", 21)], [asins[1]!, prediction(asins[1]!, "No", 22)], [asins[2]!, prediction(asins[2]!, "No", 700, false)]]);
    expect(await runSales7dStage(store, { health: async () => undefined, sales7d: async (asin) => values.get(asin)! })).toBe(0);
    expect(store.exports.count()).toBe(1);
    expect(store.exports.rows()[0]).toMatchObject({ asin: asins[0], daily_sales_3_plus: "yes" });
    expect(store.sales.counts()).toEqual({ filtered_no: 2, retained: 1 });
    expect(store.sales.thresholdCounts()).toEqual({ "3": 3 });
    expect(store.summary()).toMatchObject({ dailySalesMinimumTaskStates: { filtered_no: 2, retained: 1 }, dailySalesMinimumThresholds: { "3": 3 } });
    expect(store.db.prepare("SELECT asin,daily_sales_minimum,result,state FROM sales_7d_tasks ORDER BY asin").all()).toEqual([
      { asin: asins[0], daily_sales_minimum: 3, result: "yes", state: "retained" },
      { asin: asins[1], daily_sales_minimum: 3, result: "No", state: "filtered_no" },
      { asin: asins[2], daily_sales_minimum: 3, result: "No", state: "filtered_no" },
    ]);
    const audit = store.db.prepare("SELECT sales_7d_daily_minimum,sales_7d_state,sales_7d_result,sales_7d_complete,daily_sales_3_plus,sales_window_start,sales_window_end,sales_7d_days_json FROM asin_candidates WHERE asin=?").get(asins[0]) as {
      sales_7d_daily_minimum: number; sales_7d_state: string; sales_7d_result: string; sales_7d_complete: number; daily_sales_3_plus: string; sales_window_start: string; sales_window_end: string; sales_7d_days_json: string;
    };
    expect(audit).toMatchObject({ sales_7d_daily_minimum: 3, sales_7d_state: "retained", sales_7d_result: "yes", sales_7d_complete: 1, daily_sales_3_plus: "yes", sales_window_start: "2026-08-06", sales_window_end: "2026-08-12" });
    expect(JSON.parse(audit.sales_7d_days_json)).toHaveLength(7);
    store.close();
  });

  it("uses daily minimum 3 across the full initial price range", async () => {
    const { store } = runFixture();
    const asins = seedCandidates(store, 4);
    [699, 1698, 1699, 5000].forEach((price, index) => {
      store.db.prepare("UPDATE store_asin_occurrences SET price_pence=? WHERE asin=?").run(price, asins[index]);
      addEnrichment(store, asins[index]!, dateForAge(12), "FBA", 3, null);
    });
    store.setStage("enrich", "completed");
    await runFilterStage(store);
    const calls: Array<{ asin: string; asOfDate: string; dailySalesMinimum: number }> = [];
    expect(await runSales7dStage(store, {
      health: async () => undefined,
      sales7d: async (asin, asOfDate, dailySalesMinimum) => {
        calls.push({ asin, asOfDate, dailySalesMinimum });
        return prediction(asin, "yes", dailySalesMinimum, true, dailySalesMinimum);
      },
    })).toBe(0);
    expect(calls).toEqual(asins.map((asin) => ({ asin, asOfDate: AS_OF_DATE, dailySalesMinimum: 3 })));
    expect(store.exports.count()).toBe(4);
    store.close();
  });

  it("pauses when a persisted sales task does not match the fixed run threshold", async () => {
    const { store } = runFixture();
    const [asin] = seedCandidates(store, 1);
    addEnrichment(store, asin!, dateForAge(12), "FBA", 3, null);
    store.setStage("enrich", "completed");
    await runFilterStage(store);
    const window = fixedSales7dWindow(AS_OF_DATE);
    store.sales.materialize(window.asOfDate, window.windowStart, window.windowEnd, 3);
    store.db.prepare("UPDATE sales_7d_tasks SET daily_sales_minimum=4 WHERE asin=?").run(asin);
    expect(await runSales7dStage(store, {
      health: async () => { throw new Error("health must not be called"); },
      sales7d: async () => { throw new Error("sales7d must not be called"); },
    })).toBe(2);
    expect(store.exports.count()).toBe(1);
    expect(store.sales.counts()).toEqual({ pending: 1 });
    store.close();
  });

  it("pauses on a protocol failure without deleting the candidate", async () => {
    const { store } = runFixture();
    const [asin] = seedCandidates(store, 1);
    addEnrichment(store, asin!, dateForAge(12), "FBA", 3, null);
    store.setStage("enrich", "completed");
    await runFilterStage(store);
    expect(await runSales7dStage(store, { health: async () => undefined, sales7d: async () => { throw new Error("protocol"); } })).toBe(2);
    expect(store.exports.count()).toBe(1);
    expect(store.candidates.counts()).toEqual({ sales_pending: 1 });
    expect(store.sales.counts()).toEqual({ failed: 1 });
    expect(store.db.prepare("SELECT sales_7d_state,sales_7d_daily_minimum FROM asin_candidates WHERE asin=?").get(asin)).toEqual({ sales_7d_state: "failed", sales_7d_daily_minimum: 3 });
    store.close();
  });
});
