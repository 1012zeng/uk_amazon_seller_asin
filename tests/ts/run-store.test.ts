import { describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { RunStore } from "../../src/database/run-store.js";
import { occurrence as item, pageResult, runFixture as fixture } from "./helpers.js";

describe("schema v15 repositories", () => {
  it("creates an auditable candidate snapshot and keeps occurrence records immutable", () => {
    const { store } = fixture();
    expect(store.db.pragma("user_version", { simple: true })).toBe(15);
    expect((store.db.pragma("table_info(cleaned_products)") as Array<{ name: string }>).map((row) => row.name)).toEqual(expect.arrayContaining(["title", "category", "features_json", "overviews", "brand", "brand_url"]));
    expect((store.db.pragma("table_info(asin_candidates)") as Array<{ name: string }>).map((row) => row.name)).toEqual(expect.arrayContaining([
      "store_name", "listing_title", "price_pence", "child_sales_30d", "sales_7d_daily_minimum", "sales_7d_state", "sales_7d_days_json", "detail_state", "features_json", "brand", "brand_url",
    ]));
    expect((store.db.pragma("table_info(sales_7d_tasks)") as Array<{ name: string }>).map((row) => row.name)).toContain("daily_sales_minimum");
    store.stores.applySuccess("A123456789", 1, 1, pageResult({ occurrences: [item("A123456789", "B012345678")], displayedName: "Live", signature: "one" }));
    store.stores.applySuccess("B123456789", 1, 1, pageResult({ occurrences: [item("B123456789", "B012345678", { rating: 2 }), item("B123456789", "B087654321", { position: 2 })], signature: "two" }));
    expect(store.stores.occurrenceCount()).toBe(3);
    store.source.sealStoreSnapshot();
    expect(store.candidates.prefilter()).toMatchObject({ occurrenceCount: 3, eligibleOccurrences: 2, uniqueCandidates: 2 });
    const chosen = store.db.prepare("SELECT seller_id,store_name,listing_title,product_url,review_count,rating,price_pence FROM asin_candidates WHERE asin='B012345678'").get();
    expect(chosen).toMatchObject({ seller_id: "A123456789", store_name: "Live", listing_title: "B012345678", product_url: "https://www.amazon.co.uk/dp/B012345678", review_count: 100, rating: 4, price_pence: 1000 });
    expect(store.db.prepare("SELECT asin,child_sales_30d FROM asin_candidates_audit WHERE asin='B012345678'").get()).toEqual({ asin: "B012345678", child_sales_30d: null });
    expect(store.stores.occurrenceCount()).toBe(3);
    expect(store.database.integrityCheck()).toBe("ok");
    expect(store.db.pragma("foreign_key_check")).toEqual([]);
    store.close();
  });

  it("qualifies before deduplication and enforces inclusive/exclusive boundaries", () => {
    const { store } = fixture();
    store.stores.applySuccess("A123456789", 1, 1, pageResult({ occurrences: [item("A123456789", "B000000001", { reviewCount: 301 }), item("A123456789", "B000000002", { position: 2, rating: 3.5 }), item("A123456789", "B000000003", { position: 3, pricePence: 699 }), item("A123456789", "B000000004", { position: 4, pricePence: 5000 }), item("A123456789", "B000000005", { position: 5, rating: 3.49 })], signature: "a" }));
    store.stores.applySuccess("B123456789", 1, 1, pageResult({ occurrences: [item("B123456789", "B000000001", { reviewCount: 300 })], signature: "b" }));
    const result = store.candidates.prefilter();
    expect(result.uniqueCandidates).toBe(4);
    expect(store.candidates.listAsinsByState("mcp_pending")).toEqual(["B000000001", "B000000002", "B000000003", "B000000004"]);
    expect(store.candidates.prefilterReasonCounts()).toMatchObject({ eligible: 4, rating_lt_min: 1 });
    store.close();
  });

  it("seals partial snapshots and reports failed stores", () => {
    const { store } = fixture();
    expect(store.stores.applyFailure("A123456789", 1, 1, "unavailable", "gone").status).toBe("incomplete");
    expect(store.stores.isTerminal()).toBe(false);
    store.stores.applySuccess("B123456789", 1, 1, pageResult({ occurrences: [], signature: "", zeroResults: true, reportedTotal: 0 }));
    expect(store.stores.isTerminal()).toBe(true);
    expect(store.stores.failedStores()).toHaveLength(1);
    store.source.sealStoreSnapshot();
    expect(store.source.isStoreSnapshotSealed()).toBe(true);
    store.close();
  });

  it("keeps quarantined raw occurrences out of prefilter candidates", () => {
    const { store } = fixture();
    store.stores.applySuccess("A123456789", 1, 1, pageResult({ occurrences: [item("A123456789", "B900000001")], signature: "a" }));
    const page2 = "https://www.amazon.co.uk/s?me=B123456789&marketplaceID=A1F83G8C2ARO7P&page=2";
    store.stores.applySuccess("B123456789", 1, 1, pageResult({
      occurrences: Array.from({ length: 16 }, (_, index) => item("B123456789", `B${String(index).padStart(9, "0")}`, { position: index + 1 })),
      responseUrl: "https://www.amazon.co.uk/s?me=B123456789&marketplaceID=A1F83G8C2ARO7P&page=1",
      resultRangeStart: 1, resultRangeEnd: 16, rawCardCount: 16, reportedTotal: 32, visibleLastPage: 2, nextUrl: page2, signature: "b1",
    }));
    store.stores.applyFailure("B123456789", 1, 2, "unavailable", "HTTP 404");
    const counts = store.candidates.prefilter();
    expect(counts).toMatchObject({ occurrenceCount: 17, qualifiedOccurrenceCount: 1, excludedStoreOccurrences: 16, uniqueCandidates: 1 });
    expect(store.candidates.listAsinsByState("mcp_pending")).toEqual(["B900000001"]);
    expect(store.candidates.prefilterReasonCounts()).toMatchObject({ store_snapshot_unverified: 16 });
    store.close();
  });

  it("refuses resume when source SHA-256 changes", () => {
    const { store } = fixture();
    const runDir = store.runDir;
    const config = store.getRunConfig();
    store.close();
    writeFileSync(config.source.path, "changed");
    expect(() => new RunStore(runDir)).toThrow(/拒绝续跑.*源 Excel.*SHA-256.*改变/);
  });
});
