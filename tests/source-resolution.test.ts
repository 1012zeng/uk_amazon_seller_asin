import { describe, expect, it, vi } from "vitest";
import { runSourceResolutionStage, type ProductSellerResolver } from "../../src/stages/source-resolution.js";
import type { ProductSellerResult, SourceProductTask } from "../../src/shared/types.js";
import { runFixture } from "./helpers.js";

function success(sellerId: string, sellerName: string): Extract<ProductSellerResult, { kind: "success" }> {
  return { kind: "success", sellerId, sellerName, sellerProfileUrl: `https://www.amazon.co.uk/sp?seller=${sellerId}`, httpStatus: 200, responseBytes: 1_000, fetchMs: 20, error: "" };
}

function resolver(resolve: (task: SourceProductTask) => ProductSellerResult | Promise<ProductSellerResult>): ProductSellerResolver {
  return { start: vi.fn(async () => undefined), resolve: vi.fn(async (task) => resolve(task)), recover: vi.fn(async () => undefined), close: vi.fn(async () => undefined) };
}

describe("ASIN source seller resolution", () => {
  it("persists every product mapping and creates one store task per Seller ID", async () => {
    const { store } = runFixture({ sourceFormat: "asin_links_b" });
    const api = resolver(() => success("A123456789", "Shared Store"));
    expect(await runSourceResolutionStage(store, api)).toBe(0);
    expect(store.sourceResolution.counts()).toEqual({ resolved: 2 });
    expect(store.sourceResolution.uniqueStoreCount()).toBe(1);
    expect(store.database.integrityCheck()).toBe("ok");
    expect(store.db.pragma("foreign_key_check")).toEqual([]);
    expect(store.pendingStorePages(10)).toEqual([expect.objectContaining({
      sellerId: "A123456789",
      crawlRound: 1,
      page: 1,
      url: "https://www.amazon.co.uk/s?me=A123456789&marketplaceID=A1F83G8C2ARO7P",
      mode: "crawl",
    })]);
    expect(store.source.stageStatus("source_resolution")).toBe("completed");
    store.close();
  });

  it("retries missing sellers, preserves resolved stores, and completes partial", async () => {
    const { store } = runFixture({ sourceFormat: "asin_links_b" });
    const api = resolver((task) => task.asin === "B000000001"
      ? success("A123456789", "Store")
      : { kind: "missing", sellerId: "", sellerName: "", sellerProfileUrl: "", httpStatus: 200, responseBytes: 500, fetchMs: 10, error: "no seller" });
    expect(await runSourceResolutionStage(store, api)).toBe(3);
    expect(store.sourceResolution.counts()).toEqual({ failed: 1, resolved: 1 });
    expect(store.source.stageStatus("source_resolution")).toBe("partial");
    expect(store.source.isPartial()).toBe(true);
    store.close();
  });

  it("resumes only unfinished product links from the persisted ledger", async () => {
    const fixture = runFixture({ sourceFormat: "asin_links_b" });
    const firstTask = fixture.store.sourceResolution.pending(1)[0]!;
    fixture.store.sourceResolution.applyResolved(firstTask, success("A123456789", "First"));
    const runDir = fixture.store.runDir;
    fixture.store.close();

    const { RunStore } = await import("../../src/database/run-store.js");
    const resumed = new RunStore(runDir);
    const api = resolver(() => success("B123456789", "Second"));
    expect(await runSourceResolutionStage(resumed, api)).toBe(0);
    expect(api.resolve).toHaveBeenCalledTimes(1);
    expect(resumed.sourceResolution.uniqueStoreCount()).toBe(2);
    resumed.close();
  });

  it("finalizes a terminal ledger left behind before the stage marker commit", async () => {
    const { store } = runFixture({ sourceFormat: "asin_links_b", products: [{ asin: "B000000001", sourceRow: 2, productUrl: "https://www.amazon.co.uk/dp/B000000001" }] });
    const task = store.sourceResolution.pending(1)[0]!;
    store.sourceResolution.applyResolved(task, success("A123456789", "Store"));
    expect(store.source.stageStatus("source_resolution")).toBe("pending");
    expect(await runSourceResolutionStage(store, resolver(() => { throw new Error("must not fetch"); }))).toBe(0);
    expect(store.source.stageStatus("source_resolution")).toBe("completed");
    store.close();
  });
});
