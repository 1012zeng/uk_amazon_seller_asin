import { describe, expect, it } from "vitest";
import type { Sales7dResult } from "../../src/shared/types.js";
import { listingAgeDays, runFilterStage } from "../../src/stages/filter.js";
import { runSales7dStage } from "../../src/stages/sales-7d.js";
import { fixedSales7dWindow } from "../../src/mcp/client.js";
import { runFixture, seedCandidates } from "./helpers.js";

const AS_OF_DATE = "2026-08-13";
function dateForAge(age: number): string { return new Date(Date.UTC(2026, 7, 13 - age)).toISOString().slice(0, 10); }
function addEnrichment(store: ReturnType<typeof runFixture>["store"], asin: string, age: number, childSales: number | null, fulfillment = "FBA", variations: number | null = 3): void {
  store.db.prepare("INSERT INTO enrichments(asin,image_url,child_sales_30d,available_date,fulfillment,variation_count,enriched_at) VALUES(?,'',?,?,?,?, 'x')").run(asin, childSales, dateForAge(age), fulfillment, variations);
  store.db.prepare("UPDATE asin_candidates SET state='mcp_ok' WHERE asin=?").run(asin);
}
function prediction(asin: string, result: "yes" | "No", complete = true): Sales7dResult {
  const window = fixedSales7dWindow(AS_OF_DATE);
  return { marketplace: "UK", asin, dataType: "prediction", ...window, dailySalesMinimum: 3, complete, result, days: Array.from({ length: 7 }, (_, index) => ({ date: new Date(Date.UTC(2026, 7, 6 + index)).toISOString().slice(0, 10), sales: 3 })) };
}

describe("180-day filter and full sales-7d routing", () => {
  it.each([0, 30, 31, 179, 180, 181])("computes fixed UTC age %i", (age) => expect(listingAgeDays(dateForAge(age), AS_OF_DATE)).toBe(age));

  it("keeps age 180, rejects age 181, and sends every eligible product to sales-7d", async () => {
    const { store } = runFixture();
    const asins = seedCandidates(store, 4);
    addEnrichment(store, asins[0]!, 0, 0);
    addEnrichment(store, asins[1]!, 30, null);
    addEnrichment(store, asins[2]!, 180, 999);
    addEnrichment(store, asins[3]!, 181, 999);
    store.setStage("enrich", "completed");
    expect(await runFilterStage(store)).toBe(0);
    expect(store.candidates.counts()).toEqual({ filtered_non_sales: 1, sales_pending: 3 });
    const calls: string[] = [];
    expect(await runSales7dStage(store, { health: async () => undefined, sales7d: async (asin) => { calls.push(asin); return prediction(asin, "yes"); } })).toBe(0);
    expect(calls).toEqual(asins.slice(0, 3));
    expect(store.exports.count()).toBe(3);
    expect(store.exports.rows().map((row) => row.child_sales_30d)).toEqual([0, null, 999]);
    store.close();
  });

  it("retains FBA and variation rules while not applying child-sales bands", async () => {
    const { store } = runFixture();
    const asins = seedCandidates(store, 3);
    addEnrichment(store, asins[0]!, 31, 0, "FBA", 3);
    addEnrichment(store, asins[1]!, 31, 1, "FBA", 4);
    addEnrichment(store, asins[2]!, 31, null, "FBM", 3);
    store.setStage("enrich", "completed");
    expect(await runFilterStage(store)).toBe(0);
    expect(store.candidates.counts()).toEqual({ filtered_non_sales: 2, sales_pending: 1 });
    expect(store.db.prepare("SELECT asin,filter_reason FROM asin_candidates WHERE state='filtered_non_sales' ORDER BY asin").all()).toEqual([
      { asin: asins[1], filter_reason: "variation_count_gt_3" },
      { asin: asins[2], filter_reason: "fulfillment_not_fba" },
    ]);
    store.close();
  });

  it("persists exact yes/No results and a fixed daily minimum of 3", async () => {
    const { store } = runFixture();
    const asins = seedCandidates(store, 2);
    asins.forEach((asin) => addEnrichment(store, asin, 12, null));
    store.setStage("enrich", "completed");
    await runFilterStage(store);
    const results = new Map([[asins[0]!, prediction(asins[0]!, "yes")], [asins[1]!, prediction(asins[1]!, "No")]]);
    expect(await runSales7dStage(store, { health: async () => undefined, sales7d: async (asin) => results.get(asin)! })).toBe(0);
    expect(store.sales.counts()).toEqual({ filtered_no: 1, retained: 1 });
    expect(store.sales.thresholdCounts()).toEqual({ "3": 2 });
    expect(store.exports.rows()).toHaveLength(1);
    store.close();
  });
});
