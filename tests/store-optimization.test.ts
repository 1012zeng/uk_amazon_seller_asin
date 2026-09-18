import { describe, expect, it, vi } from "vitest";
import {
  normalizeStoreSnapshot,
  parseExactResultTotal,
  parseResultSummary,
  parseVisibleLastPage,
  validateNextStoreUrl,
  validateStoreResponseUrl,
} from "../../src/amazon/parsing.js";
import { validateStoreResponseEnvelope } from "../../src/browser/fetch.js";
import { AdaptiveConcurrencyController, isPeerRecoveryInterruption, prioritizeProxyIndices, recoveryPlan, selectDispatchableTasks, SingleFlight, StartRateLimiter } from "../../src/browser/store-scheduler.js";
import { RunDatabase } from "../../src/database/run-database.js";
import { RunStore } from "../../src/database/run-store.js";
import type { StorePageParseResult } from "../../src/shared/types.js";
import { occurrence, pageResult, runFixture } from "./helpers.js";

const MARKETPLACE = "https://www.amazon.co.uk";
const MARKETPLACE_ID = "A1F83G8C2ARO7P";

function items(sellerId: string, count: number, page: number, offset = 0) {
  return Array.from({ length: count }, (_, index) => occurrence(sellerId, `B${String(offset + index).padStart(9, "0")}`, { page, position: index + 1 }));
}

function storePage(sellerId: string, page: number, count: number, options: {
  start: number;
  total: number | null;
  lastPage: number | null;
  nextPage?: number;
  offset?: number;
  signature?: string;
  occurrences?: StorePageParseResult["occurrences"];
}): StorePageParseResult {
  const occurrences = options.occurrences ?? items(sellerId, count, page, options.offset ?? options.start - 1);
  const nextUrl = options.nextPage ? `${MARKETPLACE}/s?me=${sellerId}&marketplaceID=${MARKETPLACE_ID}&page=${options.nextPage}` : "";
  return pageResult({
    occurrences,
    responseUrl: `${MARKETPLACE}/s?me=${sellerId}&marketplaceID=${MARKETPLACE_ID}&page=${page}`,
    rawCardCount: count,
    resultRangeStart: count > 0 ? options.start : null,
    resultRangeEnd: count > 0 ? options.start + count - 1 : null,
    reportedTotal: options.total,
    visibleLastPage: options.lastPage,
    nextUrl,
    signature: options.signature ?? `page-${page}`,
  });
}

describe("single-session store scheduling", () => {
  it("starts requests no faster than two per second", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const limiter = new StartRateLimiter(2);
    const starts: number[] = [];
    const requests = Array.from({ length: 3 }, async () => { await limiter.acquire(); starts.push(Date.now()); });
    await vi.advanceTimersByTimeAsync(1_000);
    await Promise.all(requests);
    expect(starts).toEqual([0, 500, 1_000]);
    vi.useRealTimers();
  });

  it("keeps one page per seller while filling capacity with different sellers", () => {
    const tasks = [
      { sellerId: "A", crawlRound: 1 as const, page: 1, url: "a1" }, { sellerId: "A", crawlRound: 1 as const, page: 2, url: "a2" },
      { sellerId: "B", crawlRound: 1 as const, page: 1, url: "b1" }, { sellerId: "C", crawlRound: 1 as const, page: 1, url: "c1" },
    ];
    expect(selectDispatchableTasks(tasks, new Set(), new Set(), 3).map((task) => `${task.sellerId}:${task.page}`)).toEqual(["A:1", "B:1", "C:1"]);
    expect(selectDispatchableTasks(tasks, new Set(["A"]), new Set(), 3).map((task) => task.sellerId)).toEqual(["B", "C"]);
  });

  it("drops immediately to one and recovers after a stable success window", () => {
    const controller = new AdaptiveConcurrencyController({ initial: 3, min: 1, max: 3, successWindowPages: 10, cooldownMs: 60_000 });
    expect(controller.onSoftFailure(0)).toBe(2);
    expect(controller.onHardFailure(0)).toBe(1);
    for (let index = 0; index < 20; index += 1) controller.onSuccess(59_999);
    expect(controller.current).toBe(1);
    for (let index = 0; index < 10; index += 1) controller.onSuccess(60_000);
    expect(controller.current).toBe(2);
  });

  it("coalesces recovery and preserves the refresh, restart, failover order", async () => {
    const singleFlight = new SingleFlight();
    let release!: () => void;
    let calls = 0;
    const operation = () => { calls += 1; return new Promise<void>((resolve) => { release = resolve; }); };
    const first = singleFlight.run(operation);
    expect(singleFlight.run(operation)).toBe(first);
    release();
    await first;
    expect(calls).toBe(1);
    expect(recoveryPlan(0, 4, 1, 2)).toEqual([
      { kind: "refresh", proxyIndex: 0 }, { kind: "restart", proxyIndex: 0 }, { kind: "restart", proxyIndex: 0 },
      { kind: "switch", proxyIndex: 1 }, { kind: "switch", proxyIndex: 2 }, { kind: "switch", proxyIndex: 3 },
    ]);
    expect(recoveryPlan(1, 4, 1, 2, true)).toEqual([
      { kind: "switch", proxyIndex: 2 }, { kind: "switch", proxyIndex: 3 }, { kind: "switch", proxyIndex: 0 },
    ]);
    expect(prioritizeProxyIndices([7901, 7902, 7903, 7904], (port) => port === 7903)).toEqual([2, 0, 1, 3]);
    expect(isPeerRecoveryInterruption(3, 4)).toBe(true);
  });
});

describe("store response evidence", () => {
  it("parses totals, ordinal ranges and numeric pagination maxima", () => {
    expect(parseExactResultTotal("33-48 of 268 results")).toBe(268);
    expect(parseResultSummary("33-48 of 268 results")).toEqual({ start: 33, end: 48, total: 268 });
    expect(parseVisibleLastPage(["Previous", "1", "2", "3", "...", "12", "Next"])).toBe(12);
  });

  it("requires response and Next identity to stay on the same seller, marketplace and page", () => {
    const current = `${MARKETPLACE}/s?me=A123456789&marketplaceID=${MARKETPLACE_ID}&page=1`;
    expect(validateStoreResponseUrl(current, "A123456789", 1, MARKETPLACE_ID)).toBe("");
    expect(validateStoreResponseUrl(current.replace("A123456789", "OTHER"), "A123456789", 1, MARKETPLACE_ID)).toMatch(/does not match/);
    expect(validateNextStoreUrl(`/s?me=A123456789&marketplaceID=${MARKETPLACE_ID}&page=2`, current, "A123456789", 1, MARKETPLACE_ID)).toContain("page=2");
    expect(validateNextStoreUrl(`/s?me=A123456789&marketplaceID=${MARKETPLACE_ID}&page=3`, current, "A123456789", 1, MARKETPLACE_ID)).toBe("");
  });

  it("treats HTTP 202 as an anti-bot response even when search cards are present", () => {
    const current = `${MARKETPLACE}/s?me=A123456789&marketplaceID=${MARKETPLACE_ID}&page=1`;
    const result = normalizeStoreSnapshot({
      status: 202, url: current, blocked: false, hasSearch: true, zeroResults: false, displayedName: "Store",
      resultSummaryText: "1-1 of 2 results", nextHref: "", paginationTexts: ["1", "2"],
      cards: [{ asin: "B012345678", title: "P", listingHref: "/dp/B012345678", imageUrl: "", reviewText: "1", ratingText: "4", priceText: "£9.99" }],
      responseBytes: 1_000, fetchMs: 20, contentType: "text/html", declaredLength: null,
    }, "A123456789", 1, MARKETPLACE, MARKETPLACE_ID);
    expect(result.kind).toBe("blocked");
  });

  it("rejects non-HTML and oversized bodies", () => {
    const limit = 5_242_880;
    expect(() => validateStoreResponseEnvelope("application/json", null, 10, limit)).toThrow(/Content-Type/);
    expect(() => validateStoreResponseEnvelope("text/html", limit + 1, 10, limit)).toThrow(/declared/);
    expect(() => validateStoreResponseEnvelope("text/html", null, limit + 1, limit)).toThrow(/actual/);
  });
});

describe("schema v14 pagination snapshots", () => {
  it("freezes page one and completes an exact 16+7 result set", () => {
    const { store } = runFixture();
    const sellerId = "A123456789";
    const page1 = storePage(sellerId, 1, 16, { start: 1, total: 23, lastPage: 2, nextPage: 2 });
    expect(store.stores.applySuccess(sellerId, 1, 1, page1)).toMatchObject({ status: "success", boundary: { expectedLastPage: 2, safetyCeiling: 2 } });
    expect(store.pendingStorePages(10)).toContainEqual(expect.objectContaining({ sellerId, page: 2, mode: "crawl" }));
    expect(store.stores.applySuccess(sellerId, 1, 2, storePage(sellerId, 2, 7, { start: 17, total: 23, lastPage: 2 }))).toMatchObject({ status: "success" });
    const source = store.db.prepare("SELECT status,page_count,validation_state,expected_last_page,completeness_evidence FROM source_stores WHERE seller_id=?").get(sellerId) as Record<string, unknown>;
    expect(source).toMatchObject({ status: "success", page_count: 2, validation_state: "exact", expected_last_page: 2 });
    expect(JSON.parse(String(source.completeness_evidence))).toMatchObject({ exact: true, occurrenceCount: 23, uniqueAsins: 23 });
    store.close();
  });

  it("records a reported-total change and keeps traversing the frozen pages", () => {
    const { store } = runFixture();
    const sellerId = "A123456789";
    store.stores.applySuccess(sellerId, 1, 1, storePage(sellerId, 1, 16, { start: 1, total: 113, lastPage: 12, nextPage: 2 }));
    const result = store.stores.applySuccess(sellerId, 1, 2, storePage(sellerId, 2, 16, { start: 17, total: 7000, lastPage: 438, nextPage: 3 }));
    expect(result).toMatchObject({ status: "success" });
    expect(result.warnings.map((item) => item.code)).toContain("reported_total_changed");
    expect(store.db.prepare("SELECT expected_last_page FROM source_stores WHERE seller_id=?").get(sellerId)).toEqual({ expected_last_page: 12 });
    expect(store.db.prepare("SELECT COUNT(*) count FROM store_asin_occurrences WHERE seller_id=?").get(sellerId)).toEqual({ count: 0 });
    expect(store.pendingStorePages(100).filter((task) => task.sellerId === sellerId).map((task) => task.page)).toEqual(Array.from({ length: 10 }, (_, index) => index + 3));
    store.close();
  });

  it("keeps all 12 planned pages when a later response claims 70 pages", () => {
    const { store } = runFixture();
    const sellerId = "A123456789";
    store.stores.applySuccess(sellerId, 1, 1, storePage(sellerId, 1, 16, { start: 1, total: 192, lastPage: 12, nextPage: 2 }));

    const result = store.stores.applySuccess(
      sellerId,
      1,
      2,
      storePage(sellerId, 2, 16, { start: 17, total: 192, lastPage: 70, nextPage: 3 }),
    );

    expect(result).toMatchObject({ status: "success", warnings: [{ code: "visible_last_page_changed" }] });
    expect(store.db.prepare("SELECT expected_last_page FROM source_stores WHERE seller_id=?").get(sellerId))
      .toEqual({ expected_last_page: 12 });
    expect(store.db.prepare("SELECT COUNT(*) count,MAX(page) max_page FROM store_pages WHERE seller_id=? AND status='success'").get(sellerId))
      .toEqual({ count: 2, max_page: 2 });
    expect(store.db.prepare("SELECT COUNT(*) count FROM store_asin_occurrences WHERE seller_id=?").get(sellerId)).toEqual({ count: 0 });
    expect(store.db.prepare("SELECT MAX(page) max_page FROM store_pages WHERE seller_id=?").get(sellerId)).toEqual({ max_page: 12 });
    store.close();
  });

  it("accepts heavy cross-page overlap and persists only unique ASINs at completion", () => {
    const { store } = runFixture();
    const sellerId = "A123456789";
    const page1 = storePage(sellerId, 1, 16, { start: 1, total: 32, lastPage: 2, nextPage: 2, offset: 0 });
    store.stores.applySuccess(sellerId, 1, 1, page1);
    const overlapping = storePage(sellerId, 2, 16, { start: 17, total: 32, lastPage: 2, offset: 1 });
    expect(store.stores.applySuccess(sellerId, 1, 2, overlapping)).toMatchObject({ status: "success", warnings: [{ code: "cross_page_overlap" }] });
    expect(store.pendingStorePages(10).some((task) => task.sellerId === sellerId)).toBe(false);
    expect(store.db.prepare("SELECT COUNT(*) count FROM store_asin_occurrences WHERE seller_id=?").get(sellerId)).toEqual({ count: 17 });
    expect(store.stores.rawOccurrenceCount()).toBe(32);
    store.close();
  });

  it("accepts a small drift without an extra baseline request", () => {
    const { store } = runFixture();
    const sellerId = "A123456789";
    const first = storePage(sellerId, 1, 16, { start: 1, total: 45, lastPage: 3, nextPage: 2 });
    store.stores.applySuccess(sellerId, 1, 1, first);
    const drifted = storePage(sellerId, 2, 16, { start: 17, total: 52, lastPage: 3, nextPage: 3 });
    expect(store.stores.applySuccess(sellerId, 1, 2, drifted)).toMatchObject({ status: "success", warnings: [{ code: "reported_total_changed" }] });
    expect(store.pendingStorePages(10)).toContainEqual(expect.objectContaining({ sellerId, page: 3, mode: "crawl" }));
    store.stores.applySuccess(sellerId, 1, 3, storePage(sellerId, 3, 16, { start: 33, total: 52, lastPage: 3 }));
    expect(store.db.prepare("SELECT status,validation_state FROM source_stores WHERE seller_id=?").get(sellerId)).toEqual({ status: "success", validation_state: "verified_drift" });
    store.close();
  });

  it("ignores Next beyond the frozen last page", () => {
    const { store } = runFixture();
    const sellerId = "A123456789";
    store.stores.applySuccess(sellerId, 1, 1, storePage(sellerId, 1, 16, { start: 1, total: 32, lastPage: 2, nextPage: 2 }));
    const ended = store.stores.applySuccess(sellerId, 1, 2, storePage(sellerId, 2, 16, { start: 17, total: 32, lastPage: 2, nextPage: 3 }));
    expect(ended.warnings.map((item) => item.code)).toContain("next_beyond_frozen_last_page");
    expect(store.db.prepare("SELECT status,validation_state FROM source_stores WHERE seller_id=?").get(sellerId)).toEqual({ status: "success", validation_state: "verified_drift" });
    expect(store.db.prepare("SELECT 1 FROM store_pages WHERE seller_id=? AND page=3").get(sellerId)).toBeUndefined();
    store.close();
  });

  it("persists and resumes a reprobe task", () => {
    const { store } = runFixture();
    const runDir = store.runDir;
    const sellerId = "A123456789";
    store.stores.applySuccess(sellerId, 1, 1, storePage(sellerId, 1, 16, { start: 1, total: 45, lastPage: 3, nextPage: 2 }));
    store.stores.applySuccess(sellerId, 1, 2, { ...storePage(sellerId, 2, 13, { start: 17, total: 45, lastPage: 3, nextPage: 3 }), resultRangeEnd: 32 });
    store.close();
    const resumed = new RunStore(runDir);
    expect(resumed.pendingStorePages(10)).toContainEqual(expect.objectContaining({ sellerId, page: 2, mode: "reprobe" }));
    resumed.close();
  });

  it("uses one crawl round and quarantines an exhausted invalid structure", () => {
    const { store } = runFixture();
    const capture = pageResult({ occurrences: [] });
    capture.kind = "invalid_structure";
    capture.error = "Store page has no recognized result structure (HTTP 200)";
    expect(store.stores.applyFailure("A123456789", 1, 1, "invalid_structure", capture.error, capture).status).toBe("retry");
    expect(store.stores.applyFailure("A123456789", 1, 1, "invalid_structure", capture.error, capture).status).toBe("incomplete");
    expect(() => store.stores.applyFailure("A123456789", 2, 1, "error", "legacy second pass")).toThrow(/crawl_round=1/);
    expect(store.db.prepare("SELECT validation_state FROM source_stores WHERE seller_id='A123456789'").get()).toEqual({ validation_state: "quarantined" });
    store.close();
  });

  it("keeps schema v10 and older runs read-only", () => {
    const { store } = runFixture();
    const runDir = store.runDir;
    store.db.pragma("user_version = 10");
    store.close();
    expect(() => new RunDatabase(runDir)).toThrow(/schema 10 is incompatible/i);
    const readonly = new RunDatabase(runDir, { readonly: true });
    expect(readonly.schemaVersion).toBe(10);
    readonly.close();
  });
});
