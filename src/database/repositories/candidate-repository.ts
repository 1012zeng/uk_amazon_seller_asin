import type Database from "better-sqlite3";
import type { AppConfig } from "../../shared/types.js";

function nowIso(): string { return new Date().toISOString(); }
interface CountRow { count: number }

function ratingRule(filters: AppConfig["filters"]): { threshold: number; eligibleOperator: ">=" | ">"; rejectedOperator: "<" | "<="; rejectedReason: string } {
  const stored = filters as unknown as { minRatingInclusive?: unknown; minRatingExclusive?: unknown };
  if (typeof stored.minRatingInclusive === "number" && Number.isFinite(stored.minRatingInclusive)) {
    return { threshold: stored.minRatingInclusive, eligibleOperator: ">=", rejectedOperator: "<", rejectedReason: "rating_lt_min" };
  }
  if (typeof stored.minRatingExclusive === "number" && Number.isFinite(stored.minRatingExclusive)) {
    return { threshold: stored.minRatingExclusive, eligibleOperator: ">", rejectedOperator: "<=", rejectedReason: "rating_lte_min" };
  }
  throw new Error("Stored run config is missing a rating threshold");
}

export interface FilterCandidateRow {
  asin: string; seller_id: string; occurrence_id: number; image_url: string; source_name: string; live_name: string; source_profile_url: string;
  price_pence: number; review_count: number | null; rating: number | null; enriched_image_url: string; child_sales_30d: number | null;
  available_date: string; fulfillment: string; variation_count: number | null; title: string; node_label_path: string; brand: string; brand_url: string;
}

export class CandidateRepository {
  constructor(private readonly db: Database.Database, private readonly getConfig: () => AppConfig) {}

  prefilter(): { occurrenceCount: number; qualifiedOccurrenceCount: number; excludedStoreOccurrences: number; eligibleOccurrences: number; uniqueCandidates: number } {
    const f = this.getConfig().filters;
    const rating = ratingRule(f);
    return this.db.transaction(() => {
      if ((this.db.prepare("SELECT COUNT(*) count FROM asin_candidates").get() as CountRow).count > 0) return this.prefilterCounts();
      const now = nowIso();
      this.db.prepare(`WITH eligible AS (
        SELECT o.id,o.asin,o.seller_id,s.source_row,o.page,o.position,o.title,o.listing_product_url,o.product_url,o.image_url,o.review_count,o.rating,o.price_text,o.price_pence,
          ROW_NUMBER() OVER(PARTITION BY o.asin ORDER BY s.source_row,o.page,o.position,o.seller_id,o.id) choice
        FROM store_asin_occurrences o JOIN source_stores s ON s.seller_id=o.seller_id
        WHERE s.status='success' AND s.validation_state IN ('exact','verified_drift')
          AND (o.rating IS NULL OR o.rating${rating.eligibleOperator}?) AND (o.review_count IS NULL OR o.review_count<=?) AND o.price_pence IS NOT NULL AND o.price_pence BETWEEN ? AND ?
      ) INSERT INTO asin_candidates(
        asin,seller_id,occurrence_id,state,created_at,updated_at,
        store_name,store_url,seller_profile_url,page,position,listing_title,listing_product_url,product_url,image_url,
        review_count,rating,price_text,price_pence
      )
        SELECT e.asin,e.seller_id,e.id,'mcp_pending',?, ?,
          CASE WHEN s.live_name<>'' THEN s.live_name ELSE s.source_name END,s.store_url,s.source_profile_url,
          e.page,e.position,e.title,e.listing_product_url,e.product_url,e.image_url,e.review_count,e.rating,e.price_text,e.price_pence
        FROM eligible e JOIN source_stores s ON s.seller_id=e.seller_id WHERE e.choice=1 ORDER BY e.source_row,e.page,e.position,e.seller_id`)
        .run(rating.threshold, f.maxReviewCount, f.minPricePence, f.maxPricePence, now, now);
      return this.prefilterCounts();
    })();
  }

  private prefilterCounts(): { occurrenceCount: number; qualifiedOccurrenceCount: number; excludedStoreOccurrences: number; eligibleOccurrences: number; uniqueCandidates: number } {
    const f = this.getConfig().filters;
    const rating = ratingRule(f);
    const occurrenceCount = (this.db.prepare("SELECT COUNT(*) count FROM store_asin_occurrences").get() as CountRow).count;
    const qualifiedOccurrenceCount = (this.db.prepare("SELECT COUNT(*) count FROM store_asin_occurrences o JOIN source_stores s USING(seller_id) WHERE s.status='success' AND s.validation_state IN ('exact','verified_drift')").get() as CountRow).count;
    const eligibleOccurrences = (this.db.prepare(`SELECT COUNT(*) count FROM store_asin_occurrences o JOIN source_stores s USING(seller_id) WHERE s.status='success' AND s.validation_state IN ('exact','verified_drift') AND (o.rating IS NULL OR o.rating${rating.eligibleOperator}?) AND (o.review_count IS NULL OR o.review_count<=?) AND o.price_pence IS NOT NULL AND o.price_pence BETWEEN ? AND ?`).get(rating.threshold, f.maxReviewCount, f.minPricePence, f.maxPricePence) as CountRow).count;
    const uniqueCandidates = (this.db.prepare("SELECT COUNT(*) count FROM asin_candidates").get() as CountRow).count;
    return { occurrenceCount, qualifiedOccurrenceCount, excludedStoreOccurrences: occurrenceCount - qualifiedOccurrenceCount, eligibleOccurrences, uniqueCandidates };
  }

  listAsinsByState(state: string): string[] {
    return (this.db.prepare("SELECT asin FROM asin_candidates WHERE state=? ORDER BY asin").all(state) as Array<{ asin: string }>).map((row) => row.asin);
  }

  excludeHistoricalAsins(existingAsins: ReadonlySet<string>): { prefilterCandidates: number; excluded: number; eligibleForMcp: number } {
    const pending = this.listAsinsByState("mcp_pending");
    const normalized = new Set([...existingAsins].map((asin) => asin.trim().toUpperCase()).filter(Boolean));
    const update = this.db.prepare("UPDATE asin_candidates SET state='history_excluded',filter_stage='history_filter',filter_reason='asin_exists_in_history',updated_at=? WHERE asin=? AND state='mcp_pending'");
    this.db.transaction(() => {
      const now = nowIso();
      for (const asin of pending) {
        if (normalized.has(asin.trim().toUpperCase())) update.run(now, asin);
      }
    })();
    return this.historyFilterCounts();
  }

  historyFilterCounts(): { prefilterCandidates: number; excluded: number; eligibleForMcp: number } {
    const rows = this.db.prepare("SELECT state,COUNT(*) count FROM asin_candidates GROUP BY state").all() as Array<{ state: string; count: number }>;
    const prefilterCandidates = rows.reduce((total, row) => total + row.count, 0);
    const excluded = rows.find((row) => row.state === "history_excluded")?.count ?? 0;
    return { prefilterCandidates, excluded, eligibleForMcp: prefilterCandidates - excluded };
  }

  setState(asin: string, state: string, stage = "", reason = "", ageDays: number | null = null): void {
    this.db.prepare("UPDATE asin_candidates SET state=?,filter_stage=?,filter_reason=?,age_days=?,updated_at=? WHERE asin=?").run(state, stage, reason, ageDays, nowIso(), asin);
  }

  filterRows(): FilterCandidateRow[] {
    return this.db.prepare(`SELECT c.asin,c.seller_id,c.occurrence_id,o.image_url,s.source_name,s.live_name,s.source_profile_url,o.price_pence,o.review_count,o.rating,
      e.image_url enriched_image_url,e.child_sales_30d,e.available_date,e.fulfillment,e.variation_count,e.title,e.node_label_path,e.brand,e.brand_url
      FROM asin_candidates c JOIN store_asin_occurrences o ON o.id=c.occurrence_id JOIN source_stores s ON s.seller_id=c.seller_id JOIN enrichments e ON e.asin=c.asin
      WHERE c.state='mcp_ok' ORDER BY c.asin`).all() as FilterCandidateRow[];
  }

  counts(): Record<string, number> {
    const rows = this.db.prepare("SELECT state,COUNT(*) count FROM asin_candidates GROUP BY state ORDER BY state").all() as Array<{ state: string; count: number }>;
    return Object.fromEntries(rows.map((row) => [row.state, row.count]));
  }

  prefilterReasonCounts(): Record<string, number> {
    const f = this.getConfig().filters;
    const rating = ratingRule(f);
    const rows = this.db.prepare(`SELECT reason,COUNT(*) count FROM (
      SELECT CASE
        WHEN s.status<>'success' OR s.validation_state NOT IN ('exact','verified_drift') THEN 'store_snapshot_unverified'
        WHEN o.rating IS NOT NULL AND o.rating${rating.rejectedOperator}? THEN '${rating.rejectedReason}'
        WHEN o.review_count IS NOT NULL AND o.review_count>? THEN 'review_count_gt_max'
        WHEN o.price_pence IS NULL THEN 'gbp_price_missing'
        WHEN o.price_pence<? THEN 'gbp_price_lt_min'
        WHEN o.price_pence>? THEN 'gbp_price_gt_max'
        ELSE 'eligible'
      END reason FROM store_asin_occurrences o JOIN source_stores s USING(seller_id)
    ) GROUP BY reason ORDER BY reason`).all(rating.threshold, f.maxReviewCount, f.minPricePence, f.maxPricePence) as Array<{ reason: string; count: number }>;
    return Object.fromEntries(rows.map((row) => [row.reason, row.count]));
  }
}
