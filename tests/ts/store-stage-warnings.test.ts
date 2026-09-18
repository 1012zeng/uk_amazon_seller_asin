import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { occurrence, pageResult, runFixture } from "./helpers.js";

const runtimeState = vi.hoisted(() => ({ generation: 1, restarts: 0, reprobeReuses: 0 }));
const fetchCounts = vi.hoisted(() => new Map<string, number>());

vi.mock("../../src/browser/store-runtime.js", () => ({
  StoreBrowserRuntime: class {
    readonly amazon = { page: {} };
    get generation() { return runtimeState.generation; }
    readonly endpointPort = 7901;
    async start(): Promise<void> {}
    async close(): Promise<void> {}
    async recover(): Promise<void> { runtimeState.generation += 1; }
    prepareForReprobe(): void { runtimeState.reprobeReuses += 1; }
    async withNoResponseTimeout<T>(operation: () => Promise<T>): Promise<T> { return operation(); }
    observeConcurrency(): void {}
    setP95FetchMs(): void {}
    metrics() { return { browserContexts: 1, browserPages: 1, maxObservedConcurrency: 1, p95FetchMs: 1, refreshCount: 0, restartCount: runtimeState.restarts, proxySwitchCount: 0 }; }
  },
}));

vi.mock("../../src/browser/fetch.js", () => ({
  fetchStoreSnapshot: vi.fn(async (_page: unknown, url: string) => {
    const parsed = new URL(url);
    const sellerId = parsed.searchParams.get("me") ?? "";
    const page = Number(parsed.searchParams.get("page") ?? "1");
    const key = `${sellerId}:${page}`;
    const call = (fetchCounts.get(key) ?? 0) + 1;
    fetchCounts.set(key, call);
    const control = sellerId === "B123456789";
    const count = control ? 1 : 16;
    const start = control ? 1 : (page - 1) * 16 + 1;
    const total = control ? 1 : page === 1 && call === 1 ? 45 : 52;
    const lastPage = control ? 1 : 3;
    const nextHref = page < lastPage ? `/s?i=merchant-items&me=${sellerId}&marketplaceID=A1F83G8C2ARO7P&page=${page + 1}` : "";
    return {
      status: 200,
      url,
      blocked: false,
      hasSearch: true,
      zeroResults: false,
      displayedName: "Store",
      resultSummaryText: `${start}-${start + count - 1} of ${total} results`,
      nextHref,
      paginationTexts: Array.from({ length: lastPage }, (_, index) => String(index + 1)),
      cards: Array.from({ length: count }, (_, index) => ({
        asin: `B${String(start + index).padStart(9, "0")}`,
        title: `Page ${page} item ${index + 1}`,
        listingHref: `/dp/B${String(start + index).padStart(9, "0")}`,
        imageUrl: "",
        reviewText: "1",
        ratingText: "4",
        priceText: "GBP 9.99",
      })),
      responseBytes: 1_000,
      fetchMs: 1,
      contentType: "text/html",
      declaredLength: 1_000,
    };
  }),
}));

import { runStoreStage } from "../../src/stages/stores.js";

describe("store fixed pagination warning events", () => {
  it("continues across inventory drift without refetching page one", async () => {
    runtimeState.generation = 1;
    runtimeState.restarts = 0;
    runtimeState.reprobeReuses = 0;
    fetchCounts.clear();
    const { store } = runFixture();
    store.stores.applySuccess("B123456789", 1, 1, pageResult({ occurrences: [occurrence("B123456789", "B900000001")], responseUrl: "https://www.amazon.co.uk/s?me=B123456789&marketplaceID=A1F83G8C2ARO7P&page=1", signature: "control" }));
    store.setStage("source_resolution", "completed");

    expect(await runStoreStage(store)).toBe(0);
    expect(runtimeState.restarts).toBe(0);
    expect(runtimeState.reprobeReuses).toBe(0);
    expect(runtimeState.generation).toBe(1);
    const events = readFileSync(`${store.runDir}/events.jsonl`, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(events.some((event) => event.type === "store_page_validation_warning" && event.page === 2)).toBe(true);
    expect([...fetchCounts.values()]).toEqual([1, 1, 1]);
    expect(events.at(-1)).toMatchObject({ type: "stores_completed", partial: false });
    expect(store.db.prepare("SELECT status,validation_state,page_count FROM source_stores WHERE seller_id='A123456789'").get()).toEqual({ status: "success", validation_state: "verified_drift", page_count: 3 });
    store.close();
  });
});
