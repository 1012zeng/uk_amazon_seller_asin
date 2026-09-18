import { describe, expect, it } from "vitest";
import { runFixture, occurrence, pageResult } from "./helpers.js";

describe("NA-aware initial filter", () => {
  it("retains missing rating or review count while enforcing present values", () => {
    const { store } = runFixture();
    store.stores.applySuccess("A123456789", 1, 1, pageResult({ occurrences: [
      occurrence("A123456789", "B000000001", { rating: null, reviewCount: 100 }),
      occurrence("A123456789", "B000000002", { rating: 4, reviewCount: null, position: 2 }),
      occurrence("A123456789", "B000000003", { rating: null, reviewCount: null, position: 3 }),
      occurrence("A123456789", "B000000004", { rating: 3.49, reviewCount: null, position: 4 }),
      occurrence("A123456789", "B000000005", { rating: 4, reviewCount: 301, position: 5 }),
      occurrence("A123456789", "B000000006", { rating: null, reviewCount: null, pricePence: null, position: 6 }),
    ], signature: "na" }));
    store.source.sealStoreSnapshot();
    expect(store.candidates.prefilter()).toMatchObject({ eligibleOccurrences: 3, uniqueCandidates: 3 });
    expect(store.candidates.listAsinsByState("mcp_pending")).toEqual(["B000000001", "B000000002", "B000000003"]);
    expect(store.candidates.prefilterReasonCounts()).toMatchObject({ eligible: 3, rating_lt_min: 1, review_count_gt_max: 1, gbp_price_missing: 1 });
    store.close();
  });
});
