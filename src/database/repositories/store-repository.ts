import type Database from "better-sqlite3";
import {
  PaginationSnapshotGuard,
  type PaginationBaseline,
  type PaginationDecision,
  type PaginationObservation,
  type PaginationWarning,
  type StoreValidationState,
} from "../../amazon/pagination-snapshot-guard.js";
import type { AppConfig, StoreCompletenessEvidence, StoreCountWarning, StorePageParseResult } from "../../shared/types.js";
import { StorePageCache } from "../store-page-cache.js";

interface CountRow { count: number }
interface PageState {
  status: string;
  attempts: number;
  blocked_count: number;
  validation_action: string;
  validation_attempts: number;
  url: string;
}
interface SourceValidationRow {
  pagination_mode: "unknown" | PaginationBaseline["mode"];
  baseline_reported_total: number | null;
  expected_last_page: number | null;
  page_safety_ceiling: number | null;
  validation_state: StoreValidationState;
}

export type StoreCrawlRound = 1 | 2;
export interface StorePageTask {
  sellerId: string;
  crawlRound: StoreCrawlRound;
  page: number;
  url: string;
  baselineUrl: string;
  mode: "crawl" | "reprobe";
}
export interface StorePageApplyResult {
  applied: boolean;
  status: "success" | "retry" | "reprobe" | "incomplete";
  reasonCode: string;
  reason: string;
  warnings: PaginationWarning[];
  boundary: PaginationBaseline | null;
}

function nowIso(): string { return new Date().toISOString(); }
function truncate(value: unknown): string { return (value instanceof Error ? value.message : String(value ?? "")).slice(0, 4_000); }

export class StoreRepository {
  private readonly pageCache: StorePageCache;
  constructor(private readonly db: Database.Database, private readonly getConfig: () => AppConfig, runDir: string) {
    this.pageCache = new StorePageCache(runDir);
  }

  private get schemaVersion(): number { return this.db.pragma("user_version", { simple: true }) as number; }

  pageCounts(): Record<string, number> {
    const rows = this.db.prepare("SELECT status,COUNT(*) count FROM store_pages GROUP BY status ORDER BY status").all() as Array<{ status: string; count: number }>;
    return Object.fromEntries(rows.map((row) => [row.status, row.count]));
  }

  pageCountsByRound(): Record<string, Record<string, number>> {
    if (this.schemaVersion < 5) return { "1": this.pageCounts() };
    const rows = this.db.prepare("SELECT crawl_round,status,COUNT(*) count FROM store_pages GROUP BY crawl_round,status ORDER BY crawl_round,status").all() as Array<{ crawl_round: number; status: string; count: number }>;
    const result: Record<string, Record<string, number>> = {};
    for (const row of rows) (result[String(row.crawl_round)] ??= {})[row.status] = row.count;
    return result;
  }

  completenessSummary(): Record<string, unknown> {
    if (this.schemaVersion < 11) return this.legacyCompletenessSummary();
    const rows = this.db.prepare("SELECT validation_state,validation_warning_count FROM source_stores").all() as Array<{ validation_state: StoreValidationState; validation_warning_count: number }>;
    const warningCodes: Record<string, number> = {};
    for (const row of this.db.prepare("SELECT warnings_json FROM store_pages WHERE warnings_json<>'[]'").all() as Array<{ warnings_json: string }>) {
      for (const item of JSON.parse(row.warnings_json) as PaginationWarning[]) warningCodes[item.code] = (warningCodes[item.code] ?? 0) + 1;
    }
    return {
      exactCompleted: rows.filter((row) => row.validation_state === "exact").length,
      verifiedDriftCompleted: rows.filter((row) => row.validation_state === "verified_drift").length,
      quarantined: rows.filter((row) => row.validation_state === "quarantined").length,
      unverified: rows.filter((row) => row.validation_state === "unverified").length,
      storesWithWarnings: rows.filter((row) => row.validation_warning_count > 0).length,
      totalWarnings: rows.reduce((sum, row) => sum + row.validation_warning_count, 0),
      warningCodes,
      totalStores: rows.length,
    };
  }

  warningStores(): Array<Record<string, unknown>> {
    if (this.schemaVersion < 11) return this.legacyWarningStores();
    const rows = this.db.prepare(`SELECT seller_id,source_row,source_name,status,page_count,pagination_mode,baseline_reported_total,
      expected_last_page,page_safety_ceiling,validation_state,validation_warning_count,completeness_evidence
      FROM source_stores WHERE validation_warning_count>0 OR validation_state='quarantined' ORDER BY source_row`).all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      ...row,
      warnings: this.warningState(String(row.seller_id)),
      evidence: row.completeness_evidence ? JSON.parse(String(row.completeness_evidence)) : null,
    }));
  }

  failedStores(): Array<Record<string, unknown>> {
    if (this.schemaVersion < 3) return this.db.prepare("SELECT seller_id,source_row,source_name,status,error FROM source_stores WHERE status='partial' ORDER BY source_row").all() as Array<Record<string, unknown>>;
    if (this.schemaVersion < 5) return this.db.prepare("SELECT seller_id,source_row,source_name,status,error,completeness_evidence FROM source_stores WHERE status='partial' ORDER BY source_row").all() as Array<Record<string, unknown>>;
    if (this.schemaVersion < 11) return this.db.prepare("SELECT seller_id,source_row,source_name,status,crawl_round,error,first_pass_evidence,completeness_evidence FROM source_stores WHERE status='partial' ORDER BY source_row").all() as Array<Record<string, unknown>>;
    return this.db.prepare(`SELECT seller_id,source_row,source_name,status,crawl_round,pagination_mode,baseline_reported_total,
      expected_last_page,page_safety_ceiling,validation_state,validation_warning_count,error,completeness_evidence
      FROM source_stores WHERE status='partial' ORDER BY source_row`).all() as Array<Record<string, unknown>>;
  }

  downstreamEligibilityCounts(): { eligibleStores: number; excludedStores: number; eligibleOccurrences: number; excludedOccurrences: number } {
    const stores = this.db.prepare(`SELECT
      SUM(CASE WHEN status='success' AND validation_state IN ('exact','verified_drift') THEN 1 ELSE 0 END) eligible,
      SUM(CASE WHEN status='success' AND validation_state IN ('exact','verified_drift') THEN 0 ELSE 1 END) excluded
      FROM source_stores`).get() as { eligible: number | null; excluded: number | null };
    const occurrences = this.db.prepare(`SELECT
      SUM(CASE WHEN s.status='success' AND s.validation_state IN ('exact','verified_drift') THEN 1 ELSE 0 END) eligible,
      SUM(CASE WHEN s.status='success' AND s.validation_state IN ('exact','verified_drift') THEN 0 ELSE 1 END) excluded
      FROM store_asin_occurrences o JOIN source_stores s USING(seller_id)`).get() as { eligible: number | null; excluded: number | null };
    return { eligibleStores: stores.eligible ?? 0, excludedStores: stores.excluded ?? 0, eligibleOccurrences: occurrences.eligible ?? 0, excludedOccurrences: occurrences.excluded ?? 0 };
  }

  occurrenceCount(): number {
    return (this.db.prepare("SELECT COUNT(*) count FROM store_asin_occurrences").get() as CountRow).count;
  }

  rawOccurrenceCount(): number {
    return (this.db.prepare("SELECT COALESCE(SUM(result_count),0) count FROM store_pages WHERE status='success'").get() as CountRow).count;
  }

  isTerminal(): boolean {
    return !(this.db.prepare("SELECT 1 FROM store_pages WHERE status IN ('pending','retry','blocked','reprobe') LIMIT 1").get());
  }

  pendingPages(limit: number): StorePageTask[] {
    const rows = this.db.prepare(`SELECT p.seller_id,p.crawl_round,p.page,p.url,s.store_url,p.validation_action
      FROM store_pages p JOIN source_stores s USING(seller_id)
      WHERE p.status IN ('pending','retry','blocked','reprobe') AND (p.available_at='' OR p.available_at<=?)
      ORDER BY p.page,s.source_row LIMIT ?`).all(nowIso(), limit) as Array<{ seller_id: string; crawl_round: StoreCrawlRound; page: number; url: string; store_url: string; validation_action: string }>;
    return rows.map((row) => ({ sellerId: row.seller_id, crawlRound: row.crawl_round, page: row.page, url: row.url, baselineUrl: row.store_url, mode: row.validation_action === "reprobe" ? "reprobe" : "crawl" }));
  }

  applySuccess(sellerId: string, crawlRound: StoreCrawlRound, page: number, result: StorePageParseResult): StorePageApplyResult {
    if (result.kind !== "success") throw new Error(`Cannot save ${result.kind} as store success`);
    this.assertSingleRound(crawlRound);
    return this.db.transaction((): StorePageApplyResult => {
      const task = this.pageState(sellerId, crawlRound, page);
      const terminal = this.terminalResult(task.status);
      if (terminal) return terminal;
      if (task.validation_action === "reprobe") throw new Error(`Store page ${sellerId}:${page} requires applyReprobe`);
      return this.applyEvaluatedPage(sellerId, crawlRound, page, task, result, undefined, false);
    })();
  }

  applyReprobe(sellerId: string, crawlRound: StoreCrawlRound, page: number, baselineProbe: StorePageParseResult, currentProbe: StorePageParseResult): StorePageApplyResult {
    if (baselineProbe.kind !== "success" || currentProbe.kind !== "success") throw new Error("A pagination reprobe requires two successful page observations");
    this.assertSingleRound(crawlRound);
    return this.db.transaction((): StorePageApplyResult => {
      const task = this.pageState(sellerId, crawlRound, page);
      const terminal = this.terminalResult(task.status);
      if (terminal) return terminal;
      if (task.validation_action !== "reprobe") throw new Error(`Store page ${sellerId}:${page} is not awaiting a pagination reprobe`);
      return this.applyEvaluatedPage(sellerId, crawlRound, page, task, currentProbe, baselineProbe, true);
    })();
  }

  applyFailure(sellerId: string, crawlRound: StoreCrawlRound, page: number, kind: "blocked" | "unavailable" | "invalid_structure" | "error", error: unknown, capture?: StorePageParseResult): StorePageApplyResult {
    this.assertSingleRound(crawlRound);
    const config = this.getConfig();
    return this.db.transaction((): StorePageApplyResult => {
      const row = this.pageState(sellerId, crawlRound, page);
      const terminal = this.terminalResult(row.status);
      if (terminal) return terminal;
      const now = nowIso();
      let status = "";
      let attempts = row.attempts;
      let blocked = row.blocked_count;
      let availableAt = "";
      if (kind === "blocked") {
        blocked += 1;
        status = blocked >= config.stores.maxBlockedAttempts ? "blocked_exhausted" : "blocked";
        if (status === "blocked") availableAt = new Date(Date.now() + config.stores.blockedDelayMs).toISOString();
      } else if (kind === "unavailable") {
        attempts += 1;
        blocked = 0;
        status = "unavailable";
      } else {
        attempts += 1;
        blocked = 0;
        status = attempts >= config.stores.maxRetries ? "failed" : "retry";
      }
      const message = truncate(error);
      this.db.prepare(`UPDATE store_pages SET status=?,attempts=?,blocked_count=?,available_at=?,error=?,
        http_status=COALESCE(?,http_status),response_bytes=COALESCE(?,response_bytes),fetch_ms=COALESCE(?,fetch_ms),
        reported_total=COALESCE(?,reported_total),visible_last_page=COALESCE(?,visible_last_page),endpoint_port=COALESCE(?,endpoint_port),updated_at=?
        WHERE seller_id=? AND crawl_round=? AND page=?`).run(status, attempts, blocked, availableAt, message, capture?.httpStatus || null,
        capture?.responseBytes ?? null, capture?.fetchMs ?? null, capture?.reportedTotal ?? null, capture?.visibleLastPage ?? null,
        capture?.endpointPort || null, now, sellerId, crawlRound, page);
      if (["failed", "unavailable", "blocked_exhausted"].includes(status)) {
        const reasonCode = kind === "invalid_structure" ? "invalid_structure" : status === "unavailable" ? "unavailable" : status;
        return this.finishIncomplete(sellerId, crawlRound, reasonCode, message, now, []);
      }
      return { applied: true, status: "retry", reasonCode: "", reason: message, warnings: [], boundary: null };
    })();
  }

  private applyEvaluatedPage(sellerId: string, crawlRound: StoreCrawlRound, page: number, task: PageState, result: StorePageParseResult, baselineProbe: StorePageParseResult | undefined, reprobe: boolean): StorePageApplyResult {
    const now = nowIso();
    const source = this.sourceValidation(sellerId);
    const baseline = source.pagination_mode === "unknown" ? null : {
      mode: source.pagination_mode,
      initialReportedTotal: source.baseline_reported_total,
      expectedLastPage: source.expected_last_page,
      safetyCeiling: source.page_safety_ceiling ?? 1,
      initialPageSize: this.initialPageSize(sellerId),
    } satisfies PaginationBaseline;
    const current = this.observation(sellerId, crawlRound, page, result);
    const freshBaseline = baselineProbe ? this.standaloneObservation(1, baselineProbe) : undefined;
    const guard = new PaginationSnapshotGuard(this.getConfig().stores.paginationValidation);
    const decision = guard.evaluate({ baseline, previousRangeEnd: this.previousRangeEnd(sellerId, crawlRound, page), driftVerified: source.validation_state === "verified_drift", reprobe, ...(freshBaseline ? { baselineProbe: freshBaseline } : {}), configuredMaxPages: this.getConfig().stores.maxPagesPerStore, observation: current });
    const boundary = baseline === null ? decision.baseline : null;
    if (decision.baseline) this.saveBaseline(sellerId, decision.baseline, now);

    if (decision.action === "reprobe") {
      this.capturePage("reprobe", decision, result, current, now, sellerId, crawlRound, page, { validationAttempts: task.validation_attempts + 1, initialObservation: this.serializedResult(result) });
      this.updateWarningCount(sellerId, now);
      return { applied: true, status: "reprobe", reasonCode: decision.reasonCode, reason: decision.reason, warnings: decision.warnings, boundary };
    }
    if (decision.action === "quarantine") {
      this.capturePage("incomplete", decision, result, current, now, sellerId, crawlRound, page, { validationAttempts: task.validation_attempts + (reprobe ? 1 : 0), initialObservation: reprobe ? undefined : this.serializedResult(result), reprobeObservation: reprobe ? this.serializedReprobe(baselineProbe!, result) : undefined });
      this.updateWarningCount(sellerId, now);
      return this.finishIncomplete(sellerId, crawlRound, decision.reasonCode, decision.reason, now, decision.warnings, boundary);
    }

    const payloadHash = this.pageCache.write(sellerId, page, result, now);
    this.capturePage("success", decision, result, current, now, sellerId, crawlRound, page, { validationAttempts: task.validation_attempts + (reprobe ? 1 : 0), initialObservation: reprobe ? undefined : this.serializedResult(result), reprobeObservation: reprobe ? this.serializedReprobe(baselineProbe!, result) : undefined });
    this.db.prepare("UPDATE store_pages SET payload_sha256=? WHERE seller_id=? AND crawl_round=? AND page=?").run(payloadHash, sellerId, crawlRound, page);
    this.updateWarningCount(sellerId, now);
    if (result.displayedName && !/^(?:amazon|amazon resale|learn more about the seller)$/i.test(result.displayedName)) this.db.prepare("UPDATE source_stores SET live_name=?,updated_at=? WHERE seller_id=?").run(result.displayedName, now, sellerId);
    if (page === 1 && decision.baseline?.expectedLastPage !== null && decision.baseline?.expectedLastPage !== undefined) {
      for (let nextPage = 2; nextPage <= decision.baseline.expectedLastPage; nextPage += 1) this.schedulePage(sellerId, nextPage, now);
    } else if (decision.baseline?.expectedLastPage === null && decision.nextPage !== null) {
      this.schedulePage(sellerId, decision.nextPage, now);
    }
    this.finalizeIfTerminal(sellerId, crawlRound, now);
    return { applied: true, status: "success", reasonCode: "", reason: "", warnings: decision.warnings, boundary };
  }

  private assertSingleRound(crawlRound: StoreCrawlRound): void { if (crawlRound !== 1) throw new Error("Store crawling only permits crawl_round=1"); }

  private schedulePage(sellerId: string, page: number, now: string): void {
    const source = this.db.prepare("SELECT store_url FROM source_stores WHERE seller_id=?").get(sellerId) as { store_url: string };
    const url = new URL(source.store_url);
    url.searchParams.set("page", String(page));
    this.db.prepare("INSERT OR IGNORE INTO store_pages(seller_id,crawl_round,page,url,created_at,updated_at) VALUES(?,1,?,?,?,?)").run(sellerId, page, url.toString(), now, now);
  }

  private pageState(sellerId: string, crawlRound: StoreCrawlRound, page: number): PageState {
    const row = this.db.prepare("SELECT status,attempts,blocked_count,validation_action,validation_attempts,url FROM store_pages WHERE seller_id=? AND crawl_round=? AND page=?").get(sellerId, crawlRound, page) as PageState | undefined;
    if (!row) throw new Error(`Unknown store page ${sellerId}:${crawlRound}:${page}`);
    return row;
  }

  private terminalResult(status: string): StorePageApplyResult | null {
    if (status === "success") return { applied: false, status: "success", reasonCode: "", reason: "", warnings: [], boundary: null };
    if (["incomplete", "failed", "unavailable", "blocked_exhausted"].includes(status)) return { applied: false, status: "incomplete", reasonCode: "", reason: "", warnings: [], boundary: null };
    return null;
  }

  private sourceValidation(sellerId: string): SourceValidationRow {
    const row = this.db.prepare("SELECT pagination_mode,baseline_reported_total,expected_last_page,page_safety_ceiling,validation_state FROM source_stores WHERE seller_id=?").get(sellerId) as SourceValidationRow | undefined;
    if (!row) throw new Error(`Unknown source store ${sellerId}`);
    return row;
  }

  private initialPageSize(sellerId: string): number {
    const row = this.db.prepare("SELECT result_count FROM store_pages WHERE seller_id=? AND crawl_round=1 AND page=1 AND status='success'").get(sellerId) as { result_count: number } | undefined;
    return Math.max(1, row?.result_count ?? 1);
  }

  private previousRangeEnd(sellerId: string, crawlRound: StoreCrawlRound, page: number): number | null {
    if (page === 1) return null;
    const row = this.db.prepare("SELECT result_range_end FROM store_pages WHERE seller_id=? AND crawl_round=? AND page=? AND status='success'").get(sellerId, crawlRound, page - 1) as { result_range_end: number | null } | undefined;
    return row?.result_range_end ?? null;
  }

  private observation(sellerId: string, crawlRound: StoreCrawlRound, page: number, result: StorePageParseResult): PaginationObservation {
    const prior = this.db.prepare("SELECT COUNT(*) pages,COALESCE(SUM(result_count),0) occurrences FROM store_pages WHERE seller_id=? AND crawl_round=? AND page<? AND status='success'").get(sellerId, crawlRound, page) as { pages: number; occurrences: number };
    const collision = result.signature ? this.db.prepare("SELECT page FROM store_pages WHERE seller_id=? AND crawl_round=? AND page<>? AND page_signature=? AND status='success'").get(sellerId, crawlRound, page, result.signature) as { page: number } | undefined : undefined;
    const asins = [...new Set(result.occurrences.map((item) => item.asin))];
    const previous = page > 1 ? this.db.prepare("SELECT payload_sha256 FROM store_pages WHERE seller_id=? AND crawl_round=? AND page=? AND status='success'").get(sellerId, crawlRound, page - 1) as { payload_sha256: string } | undefined : undefined;
    const previousAsins = new Set(previous ? this.pageCache.read(sellerId, page - 1, previous.payload_sha256).result.occurrences.map((item) => item.asin) : []);
    const adjacentOverlapCount = asins.filter((asin) => previousAsins.has(asin)).length;
    const adjacentPageSize = previousAsins.size;
    const overlapCount = collision ? asins.length : adjacentOverlapCount;
    return { page, responseIdentityError: result.responseIdentityError, nextIdentityError: result.completenessError, resultCount: result.occurrences.length, rawCardCount: result.rawCardCount, rangeStart: result.resultRangeStart, rangeEnd: result.resultRangeEnd, reportedTotal: result.reportedTotal, visibleLastPage: result.visibleLastPage, zeroResults: result.zeroResults, hasNext: Boolean(result.nextUrl), nextPage: this.nextPage(result.nextUrl), priorPageCount: prior.pages, priorOccurrenceCount: prior.occurrences, signatureCollisionPage: collision?.page ?? null, overlapCount, adjacentOverlapCount, adjacentPageSize };
  }

  private standaloneObservation(page: number, result: StorePageParseResult): PaginationObservation {
    return { page, responseIdentityError: result.responseIdentityError, nextIdentityError: result.completenessError, resultCount: result.occurrences.length, rawCardCount: result.rawCardCount, rangeStart: result.resultRangeStart, rangeEnd: result.resultRangeEnd, reportedTotal: result.reportedTotal, visibleLastPage: result.visibleLastPage, zeroResults: result.zeroResults, hasNext: Boolean(result.nextUrl), nextPage: this.nextPage(result.nextUrl), priorPageCount: 0, priorOccurrenceCount: 0, signatureCollisionPage: null, overlapCount: 0, adjacentOverlapCount: 0, adjacentPageSize: 0 };
  }

  private nextPage(url: string): number | null {
    if (!url) return null;
    try { const value = Number(new URL(url).searchParams.get("page")); return Number.isInteger(value) && value >= 1 ? value : null; }
    catch { return null; }
  }

  private saveBaseline(sellerId: string, baseline: PaginationBaseline, now: string): void {
    this.db.prepare("UPDATE source_stores SET pagination_mode=?,baseline_reported_total=?,expected_last_page=?,page_safety_ceiling=?,updated_at=? WHERE seller_id=?").run(baseline.mode, baseline.initialReportedTotal, baseline.expectedLastPage, baseline.safetyCeiling, now, sellerId);
  }

  private promoteValidationState(sellerId: string, state: StoreValidationState, now: string): void {
    const rank: Record<StoreValidationState, number> = { unverified: 0, exact: 1, verified_drift: 2, quarantined: 3 };
    const current = (this.db.prepare("SELECT validation_state FROM source_stores WHERE seller_id=?").get(sellerId) as { validation_state: StoreValidationState }).validation_state;
    const next = rank[state] > rank[current] ? state : current;
    this.db.prepare("UPDATE source_stores SET validation_state=?,updated_at=? WHERE seller_id=?").run(next, now, sellerId);
  }

  private finalizeIfTerminal(sellerId: string, crawlRound: StoreCrawlRound, now: string): void {
    const pages = this.db.prepare("SELECT page,status,payload_sha256,error,validation_action FROM store_pages WHERE seller_id=? AND crawl_round=? ORDER BY page").all(sellerId, crawlRound) as Array<{ page: number; status: string; payload_sha256: string; error: string; validation_action: string }>;
    if (pages.some((item) => ["pending", "retry", "blocked", "reprobe"].includes(item.status))) return;

    const unique = new Map<string, { item: StorePageParseResult["occurrences"][number]; capturedAt: string }>();
    for (const page of pages.filter((item) => item.status === "success")) {
      const cached = this.pageCache.read(sellerId, page.page, page.payload_sha256);
      for (const item of [...cached.result.occurrences].sort((a, b) => a.position - b.position)) {
        if (!unique.has(item.asin)) unique.set(item.asin, { item, capturedAt: cached.capturedAt });
      }
    }
    const insert = this.db.prepare("INSERT INTO store_asin_occurrences(seller_id,asin,crawl_round,page,position,title,listing_product_url,product_url,image_url,review_count,rating,price_text,price_pence,captured_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
    for (const { item, capturedAt } of unique.values()) {
      insert.run(sellerId, item.asin, crawlRound, item.page, item.position, item.title, item.listingProductUrl, item.productUrl, item.imageUrl, item.reviewCount, item.rating, item.priceText, item.pricePence, capturedAt);
    }
    const source = this.sourceValidation(sellerId);
    const failed = pages.filter((item) => item.status !== "success");
    const covered = source.expected_last_page !== null
      ? pages.length === source.expected_last_page && pages.every((item, index) => item.page === index + 1)
      : pages.at(-1)?.validation_action === "complete";
    const complete = failed.length === 0 && covered;
    const reason = failed.length > 0 ? failed.map((item) => `Page ${item.page}: ${item.error}`).join("; ") : complete ? "" : "Frozen page coverage is incomplete";
    this.promoteValidationState(sellerId, complete ? this.warningState(sellerId).total > 0 ? "verified_drift" : "exact" : "quarantined", now);
    const evidence = this.evidence(sellerId, crawlRound, complete, complete ? "" : "page_failures", reason);
    this.db.prepare("UPDATE source_stores SET status=?,page_count=?,completeness_evidence=?,error=?,updated_at=? WHERE seller_id=?").run(complete ? "success" : "partial", pages.length, evidence, truncate(reason), now, sellerId);
  }

  private capturePage(status: string, decision: PaginationDecision, result: StorePageParseResult, observation: PaginationObservation, now: string, sellerId: string, crawlRound: StoreCrawlRound, page: number, options: { validationAttempts: number; initialObservation?: string | undefined; reprobeObservation?: string | undefined }): void {
    const ratio = observation.resultCount > 0 ? observation.adjacentOverlapCount / Math.max(1, Math.min(observation.resultCount, observation.adjacentPageSize || observation.resultCount)) : 0;
    this.db.prepare(`UPDATE store_pages SET status=@status,result_count=@resultCount,next_url=@nextUrl,page_signature=@signature,response_url=@responseUrl,
      raw_card_count=@rawCardCount,result_range_start=@rangeStart,result_range_end=@rangeEnd,visible_last_page=@visibleLastPage,
      overlap_count=@overlapCount,overlap_ratio=@overlapRatio,warnings_json=@warningsJson,validation_action=@validationAction,
      initial_observation_json=CASE WHEN @initialObservation IS NULL THEN initial_observation_json ELSE @initialObservation END,
      reprobe_observation_json=CASE WHEN @reprobeObservation IS NULL THEN reprobe_observation_json ELSE @reprobeObservation END,
      validation_attempts=@validationAttempts,http_status=@httpStatus,response_bytes=@responseBytes,fetch_ms=@fetchMs,reported_total=@reportedTotal,
      endpoint_port=@endpointPort,available_at='',error=@error,updated_at=@now WHERE seller_id=@sellerId AND crawl_round=@crawlRound AND page=@page`).run({
      status, resultCount: result.occurrences.length, nextUrl: result.nextUrl, signature: result.signature, responseUrl: result.responseUrl,
      rawCardCount: result.rawCardCount, rangeStart: result.resultRangeStart, rangeEnd: result.resultRangeEnd, visibleLastPage: result.visibleLastPage,
      overlapCount: observation.overlapCount, overlapRatio: ratio, warningsJson: JSON.stringify(decision.warnings), validationAction: decision.action,
      initialObservation: options.initialObservation ?? null, reprobeObservation: options.reprobeObservation ?? null, validationAttempts: options.validationAttempts,
      httpStatus: result.httpStatus || null, responseBytes: result.responseBytes, fetchMs: result.fetchMs, reportedTotal: result.reportedTotal,
      endpointPort: result.endpointPort || null, error: decision.reason, now, sellerId, crawlRound, page,
    });
  }

  private serializedResult(result: StorePageParseResult): string {
    return JSON.stringify({ responseUrl: result.responseUrl, reportedTotal: result.reportedTotal, resultSummaryText: result.resultSummaryText, visibleLastPage: result.visibleLastPage, resultRangeStart: result.resultRangeStart, resultRangeEnd: result.resultRangeEnd, rawCardCount: result.rawCardCount, nextUrl: result.nextUrl, signature: result.signature });
  }

  private serializedReprobe(baseline: StorePageParseResult, current: StorePageParseResult): string {
    return JSON.stringify({ baseline: JSON.parse(this.serializedResult(baseline)), current: JSON.parse(this.serializedResult(current)) });
  }

  private warningState(sellerId: string): { total: number; codes: string[]; counts: Record<string, number> } {
    const counts: Record<string, number> = {};
    let total = 0;
    const rows = this.db.prepare("SELECT warnings_json FROM store_pages WHERE seller_id=? AND warnings_json<>'[]' ORDER BY page").all(sellerId) as Array<{ warnings_json: string }>;
    for (const row of rows) for (const item of JSON.parse(row.warnings_json) as PaginationWarning[]) { total += 1; counts[item.code] = (counts[item.code] ?? 0) + 1; }
    return { total, codes: Object.keys(counts).sort(), counts };
  }

  private updateWarningCount(sellerId: string, now: string): void {
    this.db.prepare("UPDATE source_stores SET validation_warning_count=?,updated_at=? WHERE seller_id=?").run(this.warningState(sellerId).total, now, sellerId);
  }

  private evidence(sellerId: string, crawlRound: StoreCrawlRound, traversalComplete: boolean, reasonCode: string, reason: string): string {
    const source = this.sourceValidation(sellerId);
    const stats = this.db.prepare("SELECT COUNT(*) occurrences,COUNT(DISTINCT asin) unique_asins FROM store_asin_occurrences WHERE seller_id=?").get(sellerId) as { occurrences: number; unique_asins: number };
    const warnings = this.warningState(sellerId);
    const raw = (this.db.prepare("SELECT COALESCE(SUM(result_count),0) count FROM store_pages WHERE seller_id=? AND crawl_round=? AND status='success'").get(sellerId, crawlRound) as CountRow).count;
    return JSON.stringify({ crawlRound, exact: traversalComplete && source.validation_state === "exact", structural: traversalComplete, traversalComplete, validationState: source.validation_state, boundarySource: source.pagination_mode, baselineReportedTotal: source.baseline_reported_total, expectedLastPage: source.expected_last_page, pageSafetyCeiling: source.page_safety_ceiling, fetchedPages: this.pageCount(sellerId, crawlRound), reasonCode, reason, warningCodes: warnings.codes, warningCounts: warnings.counts, occurrenceCount: stats.occurrences, uniqueAsins: stats.unique_asins, rawOccurrenceCount: raw, duplicateOccurrenceCount: raw - stats.occurrences });
  }

  private pageCount(sellerId: string, crawlRound: StoreCrawlRound): number {
    return (this.db.prepare("SELECT COUNT(*) count FROM store_pages WHERE seller_id=? AND crawl_round=? AND status IN ('success','incomplete')").get(sellerId, crawlRound) as CountRow).count;
  }

  private finishIncomplete(sellerId: string, crawlRound: StoreCrawlRound, reasonCode: string, reason: string, now: string, warnings: PaginationWarning[], boundary: PaginationBaseline | null = null): StorePageApplyResult {
    this.finalizeIfTerminal(sellerId, crawlRound, now);
    return { applied: true, status: "incomplete", reasonCode, reason, warnings, boundary };
  }

  private legacyCompletenessSummary(): Record<string, unknown> {
    const empty = { exactCompleted: 0, structurallyCompleted: 0, warningCompleted: 0, reportedTotalChanged: 0, missingReportedTotal: 0, countMismatch: 0, secondPassAttempted: 0, secondPassStructurallyCompleted: 0, secondPassExactCompleted: 0, secondPassWarningCompleted: 0, secondPassPartial: 0, totalStores: 0 };
    if (this.schemaVersion < 3) { empty.totalStores = (this.db.prepare("SELECT COUNT(*) count FROM source_stores").get() as CountRow).count; return empty; }
    const rows = this.db.prepare(this.schemaVersion >= 5 ? "SELECT status,crawl_round,completeness_evidence FROM source_stores" : "SELECT status,1 crawl_round,completeness_evidence FROM source_stores").all() as Array<{ status: string; crawl_round: number; completeness_evidence: string }>;
    const result = { ...empty, totalStores: rows.length };
    for (const row of rows) {
      if (row.crawl_round === 2) result.secondPassAttempted += 1;
      if (!row.completeness_evidence) continue;
      try {
        const evidence = JSON.parse(row.completeness_evidence) as Partial<StoreCompletenessEvidence>;
        const warningCodes = new Set((evidence.warnings ?? []).map((item) => item.code));
        if (evidence.exact) result.exactCompleted += 1;
        if (evidence.structural) result.structurallyCompleted += 1;
        if (evidence.structural && warningCodes.size > 0) result.warningCompleted += 1;
        if (warningCodes.has("reported_total_changed")) result.reportedTotalChanged += 1;
        if (warningCodes.has("missing_reported_total")) result.missingReportedTotal += 1;
        if (warningCodes.has("count_mismatch")) result.countMismatch += 1;
        if (row.crawl_round === 2 && evidence.structural) result.secondPassStructurallyCompleted += 1;
        if (row.crawl_round === 2 && evidence.exact) result.secondPassExactCompleted += 1;
        if (row.crawl_round === 2 && evidence.structural && warningCodes.size > 0) result.secondPassWarningCompleted += 1;
        if (row.crawl_round === 2 && row.status === "partial") result.secondPassPartial += 1;
      } catch { /* Historical evidence remains read-only. */ }
    }
    return result;
  }

  private legacyWarningStores(): Array<Record<string, unknown>> {
    if (this.schemaVersion < 3) return [];
    const rows = this.db.prepare(this.schemaVersion >= 5 ? "SELECT seller_id,source_row,source_name,status,crawl_round,page_count,completeness_evidence FROM source_stores WHERE completeness_evidence<>'' ORDER BY source_row" : "SELECT seller_id,source_row,source_name,status,1 crawl_round,page_count,completeness_evidence FROM source_stores WHERE completeness_evidence<>'' ORDER BY source_row").all() as Array<{ seller_id: string; source_row: number; source_name: string; status: string; crawl_round: number; page_count: number; completeness_evidence: string }>;
    return rows.flatMap((row) => {
      try {
        const evidence = JSON.parse(row.completeness_evidence) as Partial<StoreCompletenessEvidence> & { reasonCode?: string; reason?: string };
        const warnings: StoreCountWarning[] = evidence.warnings ?? (["missing_reported_total", "reported_total_changed", "count_mismatch"].includes(evidence.reasonCode ?? "") ? [{ code: evidence.reasonCode as StoreCountWarning["code"], message: evidence.reason ?? "", firstObservedPage: 0 }] : []);
        return warnings.length > 0 ? [{ ...row, warnings, reportedTotals: evidence.reportedTotals ?? [], roundOccurrenceCount: evidence.roundOccurrenceCount ?? 0, roundUniqueAsins: evidence.roundUniqueAsins ?? 0 }] : [];
      } catch { return []; }
    });
  }
}
