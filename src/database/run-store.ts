import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { AppConfig, SourceProductLink, SourceStoreStats, StageName, StageStatus, StorePageParseResult, StoreSeed } from "../shared/types.js";
import { loadConfig } from "../shared/config.js";
import { appendEvent } from "../shared/utils.js";
import { RunDatabase, SCHEMA_VERSION } from "./run-database.js";
import { CandidateRepository } from "./repositories/candidate-repository.js";
import { DetailRepository } from "./repositories/detail-repository.js";
import { EnrichmentRepository } from "./repositories/enrichment-repository.js";
import { ExportRepository } from "./repositories/export-repository.js";
import { SalesRepository } from "./repositories/sales-repository.js";
import { SourceRepository } from "./repositories/source-repository.js";
import { SourceResolutionRepository } from "./repositories/source-resolution-repository.js";
import { StoreRepository } from "./repositories/store-repository.js";
import type { StoreCrawlRound, StorePageApplyResult, StorePageTask } from "./repositories/store-repository.js";

export class RunStore {
  readonly database: RunDatabase;
  readonly db;
  readonly runDir: string;
  readonly source: SourceRepository;
  readonly sourceResolution: SourceResolutionRepository;
  readonly stores: StoreRepository;
  readonly candidates: CandidateRepository;
  readonly details: DetailRepository;
  readonly enrichments: EnrichmentRepository;
  readonly exports: ExportRepository;
  readonly sales: SalesRepository;

  constructor(runDir: string, options: { readonly?: boolean } = {}) {
    this.database = new RunDatabase(runDir, options);
    this.db = this.database.connection;
    this.runDir = this.database.runDir;
    this.source = new SourceRepository(this.db);
    const getConfig = (): AppConfig => this.source.getConfig();
    this.sourceResolution = new SourceResolutionRepository(this.db, getConfig);
    this.stores = new StoreRepository(this.db, getConfig, this.runDir);
    this.candidates = new CandidateRepository(this.db, getConfig);
    this.details = new DetailRepository(this.db);
    this.enrichments = new EnrichmentRepository(this.db);
    this.exports = new ExportRepository(this.db);
    this.sales = new SalesRepository(this.db, this.exports);
    if (!options.readonly && this.db.prepare("SELECT 1 FROM run_meta LIMIT 1").get()) this.assertResumeContract();
  }

  initialize(runId: string, config: AppConfig, sourceHash: string, seeds: StoreSeed[], stats: SourceStoreStats, startedAt?: string, products: SourceProductLink[] = []): void {
    this.db.transaction(() => {
      this.source.initialize(runId, config, sourceHash, seeds, stats, startedAt);
      this.sourceResolution.seed(products, startedAt);
    })();
  }

  assertResumeContract(): void {
    const meta = this.source.getMeta() as { config_path: string; config_hash: string; source_path: string; source_hash: string; as_of_date: string; contract_hash: string };
    const current = loadConfig(meta.config_path);
    if (current.configHash !== meta.config_hash) throw new Error("拒绝续跑：任务创建后的配置哈希已改变");
    const sourceHash = createHash("sha256").update(readFileSync(meta.source_path)).digest("hex");
    if (sourceHash !== meta.source_hash) throw new Error("拒绝续跑：源 Excel 的 SHA-256 已改变");
    const contract = createHash("sha256").update(JSON.stringify({ schema: SCHEMA_VERSION, configHash: current.configHash, sourceHash, asOfDate: meta.as_of_date })).digest("hex");
    if (contract !== meta.contract_hash) throw new Error("拒绝续跑：任务运行合同已改变");
  }

  getRunId(): string { return this.source.getRunId(); }
  getRunConfig(): AppConfig { return this.source.getConfig(); }
  getAsOfDate(): string { return String(this.source.getMeta().as_of_date); }
  setStage(stage: StageName, status: StageStatus, error = ""): void {
    this.source.setStage(stage, status, error);
    if (status === "running") appendEvent(this.runDir, "stage_started", { stage });
  }
  completeHistoryFilter(existingAsins: ReadonlySet<string>): { prefilterCandidates: number; excluded: number; eligibleForMcp: number } {
    return this.db.transaction(() => {
      const counts = this.candidates.excludeHistoricalAsins(existingAsins);
      this.setStage("history_filter", "completed");
      return counts;
    })();
  }
  storePageCounts(): Record<string, number> { return this.stores.pageCounts(); }
  storeStageIsTerminal(): boolean { return this.stores.isTerminal(); }
  pendingStorePages(limit: number): StorePageTask[] { return this.stores.pendingPages(limit); }
  applyStorePageSuccess(sellerId: string, crawlRound: StoreCrawlRound, page: number, result: StorePageParseResult): StorePageApplyResult { return this.stores.applySuccess(sellerId, crawlRound, page, result); }
  applyStorePageReprobe(sellerId: string, crawlRound: StoreCrawlRound, page: number, baseline: StorePageParseResult, current: StorePageParseResult): StorePageApplyResult { return this.stores.applyReprobe(sellerId, crawlRound, page, baseline, current); }
  applyStorePageFailure(sellerId: string, crawlRound: StoreCrawlRound, page: number, kind: "blocked" | "unavailable" | "invalid_structure" | "error", error: unknown, capture?: StorePageParseResult): StorePageApplyResult { return this.stores.applyFailure(sellerId, crawlRound, page, kind, error, capture); }
  close(): void { this.database.close(); }

  summary(): Record<string, unknown> {
    const meta = this.source.getMeta();
    const stages = this.db.prepare(`SELECT stage,status,error,started_at,completed_at,updated_at FROM run_stages ORDER BY CASE stage
      WHEN 'import' THEN 1 WHEN 'source_resolution' THEN 2 WHEN 'stores' THEN 3 WHEN 'prefilter' THEN 4 WHEN 'history_filter' THEN 5 WHEN 'enrich' THEN 6 WHEN 'filter' THEN 7 WHEN 'sales_7d' THEN 8 WHEN 'detail' THEN 9 WHEN 'export' THEN 10 ELSE 99 END`).all();
    return {
      schemaVersion: this.database.schemaVersion,
      runId: meta.run_id,
      status: meta.status,
      currentStage: meta.current_stage,
      complete: Boolean(meta.complete),
      partial: Boolean(meta.partial),
      runStartedAt: meta.run_started_at,
      asOfDate: meta.as_of_date,
      source: { path: meta.source_path, sheet: meta.source_sheet, sha256: meta.source_hash, stats: JSON.parse(String(meta.source_stats_json)) },
      storeSnapshotSealedAt: meta.store_snapshot_sealed_at,
      stages,
      sourceResolution: { counts: this.sourceResolution.counts(), uniqueStores: this.sourceResolution.uniqueStoreCount() },
      stores: {
        pages: this.stores.pageCounts(), pagesByRound: this.stores.pageCountsByRound(), rawOccurrences: this.stores.rawOccurrenceCount(), occurrences: this.stores.occurrenceCount(), failed: this.stores.failedStores(), warnings: this.stores.warningStores(),
        completeness: this.stores.completenessSummary(), downstreamEligibility: this.stores.downstreamEligibilityCounts(), runtime: JSON.parse(String(meta.store_runtime_json || "{}")),
      },
      prefilter: this.candidates.prefilterReasonCounts(),
      historyFilter: this.candidates.historyFilterCounts(),
      candidates: this.candidates.counts(),
      mcpBatches: this.enrichments.counts(),
      dailySalesMinimumTaskStates: this.sales.counts(),
      dailySalesMinimumThresholds: this.sales.thresholdCounts(),
      asinDetailTaskStates: this.details.counts(),
      cleanedProducts: this.exports.count(),
      integrity: this.database.integrityCheck(),
    };
  }
}
