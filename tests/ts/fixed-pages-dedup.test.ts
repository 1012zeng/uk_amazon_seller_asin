import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { normalizeStoreSnapshot, parseResultSummary } from "../../src/amazon/parsing.js";
import { RunStore } from "../../src/database/run-store.js";
import { occurrence, pageResult, runFixture } from "./helpers.js";

const seller = "A123456789";
function repeatedPage(page: number, lastPage: number) {
  return normalizeStoreSnapshot({
    status: 200, url: `https://www.amazon.co.uk/s?me=${seller}&marketplaceID=A1F83G8C2ARO7P&page=${page}`,
    blocked: false, hasSearch: true, zeroResults: false, displayedName: "HappyStor",
    resultSummaryText: `${(page - 1) * 16 + 1}-${page * 16} of over 8,000 results`,
    nextHref: "", paginationTexts: ["1", "...", String(lastPage)],
    cards: Array.from({ length: 16 }, (_, index) => ({ asin: `B${String(index).padStart(9, "0")}`, title: `First seen on page ${page}`, listingHref: "", imageUrl: "", reviewText: "10", ratingText: "4.5", priceText: "£9.99" })),
    responseBytes: 1000, fetchMs: 1, contentType: "text/html", declaredLength: null,
  }, seller, page, "https://www.amazon.co.uk", "A1F83G8C2ARO7P");
}

describe("fixed page traversal and deferred ASIN persistence", () => {
  it.each(["1-16 of over 8,000 results", "1–16 of about 8,000 results", "1-16 of more than 8,000 results"])("parses ranges independently of approximate totals: %s", (text) => {
    expect(parseResultSummary(text)).toEqual({ start: 1, end: 16, total: null });
  });

  it("fetches all 400 planned pages without Next, accepts repeats and writes unique ASINs only at the end", () => {
    const { store } = runFixture();
    try {
      expect(store.stores.applySuccess(seller, 1, 1, repeatedPage(1, 400)).status).toBe("success");
      const tasks = store.pendingStorePages(500).filter((task) => task.sellerId === seller);
      expect(tasks).toHaveLength(399);
      expect(tasks.at(-1)?.page).toBe(400);
      for (const task of tasks) {
        const url = new URL(task.url);
        expect(url.searchParams.get("page")).toBe(String(task.page));
        expect(url.searchParams.get("me")).toBe(seller);
        expect(url.searchParams.get("i")).toBe("merchant-items");
      }
      for (let page = 2; page <= 400; page += 1) {
        expect(store.stores.occurrenceCount()).toBe(0);
        expect(store.stores.completenessSummary()).toMatchObject({ exactCompleted: 0, verifiedDriftCompleted: 0 });
        expect(store.stores.applySuccess(seller, 1, page, repeatedPage(page, 400)).status).toBe("success");
      }
      expect(store.stores.occurrenceCount()).toBe(16);
      expect(store.db.prepare("SELECT DISTINCT page,title FROM store_asin_occurrences").all()).toEqual([{ page: 1, title: "First seen on page 1" }]);
      const source = store.db.prepare("SELECT status,page_count,expected_last_page,completeness_evidence FROM source_stores WHERE seller_id=?").get(seller) as Record<string, unknown>;
      expect(source).toMatchObject({ status: "success", page_count: 400, expected_last_page: 400 });
      expect(JSON.parse(String(source.completeness_evidence))).toMatchObject({ rawOccurrenceCount: 6400, uniqueAsins: 16, duplicateOccurrenceCount: 6384 });
      expect(store.db.prepare("SELECT MAX(page) maximum FROM store_pages WHERE seller_id=?").get(seller)).toEqual({ maximum: 400 });
      expect(store.database.integrityCheck()).toBe("ok");
    } finally { store.close(); }
  });

  it("resumes page files and preserves the first occurrence before filtering", () => {
    let { store } = runFixture();
    const runDir = store.runDir;
    store.stores.applySuccess(seller, 1, 1, pageResult({ occurrences: [occurrence(seller, "B000000001", { rating: 2 })], visibleLastPage: 3, signature: "first" }));
    expect(store.stores.occurrenceCount()).toBe(0);
    const cached = path.join(runDir, "store-page-cache", seller, "1.json");
    expect(existsSync(cached)).toBe(true);
    const before = readFileSync(cached, "utf8");
    store.close();
    store = new RunStore(runDir);
    try {
      store.stores.applySuccess(seller, 1, 2, pageResult({ occurrences: [occurrence(seller, "B000000001", { page: 2, rating: 5 })], visibleLastPage: 3, signature: "second" }));
      expect(store.stores.occurrenceCount()).toBe(0);
      store.stores.applySuccess(seller, 1, 3, pageResult({ occurrences: [occurrence(seller, "B000000002", { page: 3 })], visibleLastPage: 3, signature: "third" }));
      expect(store.stores.occurrenceCount()).toBe(2);
      expect(store.db.prepare("SELECT rating,page FROM store_asin_occurrences WHERE asin='B000000001'").get()).toEqual({ rating: 2, page: 1 });
      expect(readFileSync(cached, "utf8")).toBe(before);
      expect(store.candidates.prefilter().uniqueCandidates).toBe(1);
    } finally { store.close(); }
  });

  it("continues remaining planned pages after a failed page and records a partial result", () => {
    const { store } = runFixture();
    try {
      store.stores.applySuccess(seller, 1, 1, repeatedPage(1, 3));
      store.stores.applyFailure(seller, 1, 2, "unavailable", "HTTP 404");
      expect(store.pendingStorePages(20)).toContainEqual(expect.objectContaining({ sellerId: seller, page: 3 }));
      expect(store.stores.occurrenceCount()).toBe(0);
      store.stores.applySuccess(seller, 1, 3, repeatedPage(3, 3));
      expect(store.stores.occurrenceCount()).toBe(16);
      expect(store.stores.failedStores()).toContainEqual(expect.objectContaining({ seller_id: seller, status: "partial" }));
      expect(store.candidates.prefilter().uniqueCandidates).toBe(0);
      expect(store.db.prepare("SELECT status FROM store_pages WHERE seller_id=? AND page=2").get(seller)).toEqual({ status: "unavailable" });
    } finally { store.close(); }
  });

  it("rolls back final ASIN insertion when an earlier page cache is corrupted", () => {
    const { store } = runFixture();
    try {
      store.stores.applySuccess(seller, 1, 1, repeatedPage(1, 3));
      store.stores.applySuccess(seller, 1, 2, repeatedPage(2, 3));
      const file = path.join(store.runDir, "store-page-cache", seller, "1.json");
      const original = readFileSync(file, "utf8");
      writeFileSync(file, original.replace("First seen on page 1", "Changed"));
      expect(() => store.stores.applySuccess(seller, 1, 3, repeatedPage(3, 3))).toThrow(/checksum mismatch/);
      expect(store.stores.occurrenceCount()).toBe(0);
      expect(store.pendingStorePages(20)).toContainEqual(expect.objectContaining({ sellerId: seller, page: 3 }));
      writeFileSync(file, original);
      store.stores.applySuccess(seller, 1, 3, repeatedPage(3, 3));
      expect(store.stores.occurrenceCount()).toBe(16);
      expect(store.stores.applySuccess(seller, 1, 3, repeatedPage(3, 3)).applied).toBe(false);
      expect(store.stores.occurrenceCount()).toBe(16);
    } finally { store.close(); }
  });
});
