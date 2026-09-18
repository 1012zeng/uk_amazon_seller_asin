import { mkdtempSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import type { AppConfig, SourceFormat, SourceProductLink, StoreAsinOccurrence, StorePageParseResult, StoreSeed } from "../../src/shared/types.js";
import { DEFAULT_PAGINATION_POLICY } from "../../src/amazon/pagination-snapshot-guard.js";
import { RunStore } from "../../src/database/run-store.js";

export function runFixture(options: { sourceFormat?: SourceFormat; products?: SourceProductLink[] } = {}): { store: RunStore; config: AppConfig; root: string } {
  const sourceFormat = options.sourceFormat ?? "seller_links_de";
  const root = mkdtempSync(path.join(os.tmpdir(), "run-v9-"));
  const source = path.join(root, "source.xlsx");
  const configPath = path.join(root, "config.yaml");
  writeFileSync(source, "fixture");
  const configText = `source:\n  path: "${source.replace(/\\/g, "/")}"\n  sheet: "产品数据"\n  limit: 0\n  format: "${sourceFormat}"\nhistoryFilter:\n  enabled: ${sourceFormat === "seller_links_de"}\namazon:\n  marketplace: "https://www.amazon.co.uk"\n  site: "amazon.co.uk"\n  marketplaceId: "A1F83G8C2ARO7P"\n  postcode: "WC1E 7HU"\n  currency: "GBP"\nbrowser:\n  headed: false\n  executablePath: ""\n  controlPath: "/robots.txt"\n  navigationTimeoutMs: 1000\n  requestTimeoutMs: 1000\n  wafWaitSeconds: 0\n  pageRefreshAttempts: 1\n  browserRestartAttempts: 2\n  noResponseTimeoutMs: 2000\n  recoveryDelayMs: 0\nstores:\n  concurrency:\n    initial: 3\n    min: 1\n    max: 3\n    successWindowPages: 10\n    cooldownMs: 60000\n  requestsPerSecond: 2\n  maxResponseBytes: 5242880\n  maxRetries: 2\n  maxBlockedAttempts: 2\n  blockedDelayMs: 0\n  maxPagesPerStore: 0\n  proxyPorts: [1, 2, 3, 4]\nsellerSprite:\n  serviceUrl: "http://127.0.0.1:8012"\n  marketplace: "UK"\n  batchSize: 40\n  requestTimeoutMs: 1000\nfilters:\n  maxReviewCount: 300\n  minRatingInclusive: 3.5\n  minPricePence: 699\n  maxPricePence: 5000\n  maxVariations: 3\n  maxNewAgeDays: 30\n  firstChildSalesBandMaxAgeDays: 365\n  secondChildSalesBandMaxAgeDays: 550\n  maxAgeDays: 720\n  firstChildSalesBandMinimum: 100\n  secondChildSalesBandMinimum: 200\n  thirdChildSalesBandMinimum: 300\n  newListingDailySalesMinimum: 3\noutput:\n  root: "${root.replace(/\\/g, "/")}"\n`;
  writeFileSync(configPath, configText);
  const config: AppConfig = {
    projectRoot: root, configPath, configHash: createHash("sha256").update(configText).digest("hex"), source: { path: source, sheet: "产品数据", limit: 0, format: sourceFormat },
    historyFilter: { enabled: sourceFormat === "seller_links_de" },
    amazon: { marketplace: "https://www.amazon.co.uk", site: "amazon.co.uk", marketplaceId: "A1F83G8C2ARO7P", postcode: "WC1E 7HU", currency: "GBP" },
    browser: { headed: false, executablePath: "", controlPath: "/robots.txt", navigationTimeoutMs: 1000, requestTimeoutMs: 1000, wafWaitSeconds: 0, pageRefreshAttempts: 1, browserRestartAttempts: 2, noResponseTimeoutMs: 2000, recoveryDelayMs: 0 },
    stores: { concurrency: { initial: 3, min: 1, max: 3, successWindowPages: 10, cooldownMs: 60000 }, requestsPerSecond: 2, maxResponseBytes: 5_242_880, maxRetries: 2, maxBlockedAttempts: 2, blockedDelayMs: 0, maxPagesPerStore: 0, paginationValidation: { ...DEFAULT_PAGINATION_POLICY }, proxyPorts: [1, 2, 3, 4] },
    sellerSprite: { serviceUrl: "http://127.0.0.1:8012", marketplace: "UK", batchSize: 40, requestTimeoutMs: 1000 },
    filters: {
      maxReviewCount: 300, minRatingInclusive: 3.5, minPricePence: 699, maxPricePence: 5000, maxVariations: 3,
      maxNewAgeDays: 30, firstChildSalesBandMaxAgeDays: 365, secondChildSalesBandMaxAgeDays: 550, maxAgeDays: 720,
      firstChildSalesBandMinimum: 100, secondChildSalesBandMinimum: 200, thirdChildSalesBandMinimum: 300, newListingDailySalesMinimum: 3,
    }, output: { root },
  };
  const store = new RunStore(path.join(root, "run"));
  const seeds: StoreSeed[] = [{ sellerId: "A123456789", sourceRow: 2, sourceName: "First", sourceProfileUrl: "https://amazon.co.uk/sp?seller=A123456789", storeUrl: "https://www.amazon.co.uk/s?i=merchant-items&me=A123456789&marketplaceID=A1F83G8C2ARO7P" }, { sellerId: "B123456789", sourceRow: 3, sourceName: "Second", sourceProfileUrl: "https://amazon.co.uk/sp?seller=B123456789", storeUrl: "https://www.amazon.co.uk/s?i=merchant-items&me=B123456789&marketplaceID=A1F83G8C2ARO7P" }];
  const sourceHash = createHash("sha256").update("fixture").digest("hex");
  const activeSeeds = sourceFormat === "seller_links_de" ? seeds : [];
  const products = options.products ?? (sourceFormat === "asin_links_b" ? [
    { asin: "B000000001", sourceRow: 2, productUrl: "https://www.amazon.co.uk/dp/B000000001" },
    { asin: "B000000002", sourceRow: 3, productUrl: "https://www.amazon.co.uk/dp/B000000002" },
  ] : []);
  store.initialize("run", config, sourceHash, activeSeeds, { sourceRows: 2, duplicateRows: 0, duplicateSellerIds: 0, uniqueStores: activeSeeds.length, appliedLimit: 0, inputKind: sourceFormat }, "2026-08-13T01:02:03.000Z", products);
  return { store, config, root };
}

export function occurrence(sellerId: string, asin: string, patch: Partial<StoreAsinOccurrence> = {}): StoreAsinOccurrence {
  return { sellerId, asin, page: 1, position: 1, title: asin, listingProductUrl: "", productUrl: `https://www.amazon.co.uk/dp/${asin}`, imageUrl: "https://example.invalid/amazon.jpg", reviewCount: 100, rating: 4, priceText: "£10.00", pricePence: 1000, ...patch };
}

export function pageResult(patch: Partial<StorePageParseResult> & Pick<StorePageParseResult, "occurrences">): StorePageParseResult {
  const sellerId = patch.occurrences[0]?.sellerId ?? "A123456789";
  const page = patch.occurrences[0]?.page ?? 1;
  const resultCount = patch.occurrences.length;
  const rangeStart = resultCount > 0 ? (page - 1) * 16 + 1 : null;
  let nextPage: number | null = null;
  try { nextPage = patch.nextUrl ? Number(new URL(patch.nextUrl).searchParams.get("page")) : null; } catch { nextPage = null; }
  return {
    kind: "success", error: "", displayedName: "", responseUrl: `https://www.amazon.co.uk/s?me=${sellerId}&marketplaceID=A1F83G8C2ARO7P&page=${page}`,
    responseIdentityError: "", nextUrl: "", signature: "page", zeroResults: false, rawCardCount: resultCount,
    resultRangeStart: rangeStart, resultRangeEnd: rangeStart === null ? null : rangeStart + resultCount - 1, visibleLastPage: Number.isInteger(nextPage) ? nextPage : page,
    httpStatus: 200, responseBytes: 1_000, fetchMs: 100, reportedTotal: patch.occurrences.length,
    endpointPort: 7901, completenessError: "", ...patch,
  };
}

export function seedCandidates(store: RunStore, count: number, completeHistoryFilter = true): string[] {
  const asins = Array.from({ length: count }, (_, index) => `B${String(index).padStart(9, "0")}`);
  const now = "2026-08-13T01:02:03.000Z";
  const insertOccurrence = store.db.prepare(`INSERT INTO store_asin_occurrences(seller_id,asin,crawl_round,page,position,title,product_url,review_count,rating,price_text,price_pence,captured_at) VALUES('A123456789',?,1,1,?,?,?,100,4,'£10.00',1000,?)`);
  const insertCandidate = store.db.prepare("INSERT INTO asin_candidates(asin,seller_id,occurrence_id,state,created_at,updated_at) VALUES(?,'A123456789',?,'mcp_pending',?,?)");
  store.db.transaction(() => asins.forEach((asin, index) => {
    const result = insertOccurrence.run(asin, index + 1, asin, `https://www.amazon.co.uk/dp/${asin}`, now);
    insertCandidate.run(asin, Number(result.lastInsertRowid), now, now);
  }))();
  store.setStage("prefilter", "completed");
  if (completeHistoryFilter) store.setStage("history_filter", "completed");
  return asins;
}
