import { describe, expect, it, vi } from "vitest";
import { runHistoryFilterStage } from "../../src/stages/history-filter.js";
import { runFixture, seedCandidates } from "./helpers.js";

describe("history ASIN filter", () => {
  it("excludes historical ASINs after prefilter and leaves the rest pending for MCP", async () => {
    const { store } = runFixture();
    const asins = seedCandidates(store, 4, false);
    const lookup = vi.fn(async () => new Set([asins[0]!.toLowerCase(), asins[2]!]));
    expect(await runHistoryFilterStage(store, { findExistingAsins: lookup })).toBe(0);
    expect(lookup).toHaveBeenCalledWith(asins);
    expect(store.candidates.listAsinsByState("history_excluded")).toEqual([asins[0], asins[2]]);
    expect(store.candidates.listAsinsByState("mcp_pending")).toEqual([asins[1], asins[3]]);
    expect(store.candidates.historyFilterCounts()).toEqual({ prefilterCandidates: 4, excluded: 2, eligibleForMcp: 2 });
    const excluded = store.db.prepare("SELECT filter_stage,filter_reason FROM asin_candidates WHERE asin=?").get(asins[0]) as { filter_stage: string; filter_reason: string };
    expect(excluded).toEqual({ filter_stage: "history_filter", filter_reason: "asin_exists_in_history" });
    expect(await runHistoryFilterStage(store, { findExistingAsins: lookup })).toBe(0);
    expect(lookup).toHaveBeenCalledTimes(1);
    store.close();
  });

  it("pauses without changing candidates when the history database fails", async () => {
    const { store } = runFixture();
    const asins = seedCandidates(store, 2, false);
    expect(await runHistoryFilterStage(store, { findExistingAsins: async () => { throw new Error("database unavailable"); } })).toBe(2);
    expect(store.source.stageStatus("history_filter")).toBe("paused");
    expect(store.candidates.listAsinsByState("mcp_pending")).toEqual(asins);
    expect(store.candidates.listAsinsByState("history_excluded")).toEqual([]);
    store.close();
  });

  it("skips the database only for the ASIN-link source contract", async () => {
    const { store } = runFixture({ sourceFormat: "asin_links_b" });
    const task = store.sourceResolution.pending(1)[0]!;
    store.sourceResolution.applyResolved(task, { kind: "success", sellerId: "A123456789", sellerName: "Store", sellerProfileUrl: "https://www.amazon.co.uk/sp?seller=A123456789", httpStatus: 200, responseBytes: 1_000, fetchMs: 20, error: "" });
    const asins = seedCandidates(store, 2, false);
    const lookup = vi.fn(async () => new Set(asins));
    expect(await runHistoryFilterStage(store, { findExistingAsins: lookup })).toBe(0);
    expect(lookup).not.toHaveBeenCalled();
    expect(store.candidates.listAsinsByState("mcp_pending")).toEqual(asins);
    expect(store.candidates.listAsinsByState("history_excluded")).toEqual([]);
    expect(store.source.stageStatus("history_filter")).toBe("completed");
    store.close();
  });
});
