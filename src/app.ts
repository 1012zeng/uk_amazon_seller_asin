import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { RunStore } from "./database/run-store.js";
import { writeExcelExport } from "./export/excel.js";
import { readAsinProductLinks } from "./input/asin-product-links.js";
import { readSellerIdsColumnB, readStoreSeeds } from "./input/source-stores.js";
import { loadConfig, projectRoot } from "./shared/config.js";
import { formatChineseStatus } from "./shared/logging.js";
import { appendEvent, truncateError, writeSummary } from "./shared/utils.js";
import { runEnrichmentStage } from "./stages/enrich.js";
import { runDetailStage } from "./stages/detail.js";
import { runFilterStage } from "./stages/filter.js";
import { runHistoryFilterStage } from "./stages/history-filter.js";
import { runPrefilterStage } from "./stages/prefilter.js";
import { runSales7dStage } from "./stages/sales-7d.js";
import { runSourceResolutionStage } from "./stages/source-resolution.js";
import { runStoreStage } from "./stages/stores.js";

function validateRunId(runId: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(runId)) throw new Error(`任务编号格式无效：${runId}`);
  return runId;
}
function registryPath(runId: string): string { return path.join(projectRoot, "output", "run-index", `${validateRunId(runId)}.json`); }
function registerRun(runId: string, runDir: string): void {
  const target = registryPath(runId);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify({ runId, runDir: path.resolve(runDir) }, null, 2)}\n`, "utf8");
}
export function resolveRunDir(runId: string): string {
  validateRunId(runId);
  const direct = path.join(projectRoot, "output", "runs", runId);
  if (existsSync(path.join(direct, "state.sqlite"))) return direct;
  const index = registryPath(runId);
  if (existsSync(index)) {
    const value = JSON.parse(readFileSync(index, "utf8")) as { runDir?: unknown };
    if (typeof value.runDir === "string" && existsSync(path.join(value.runDir, "state.sqlite"))) return path.resolve(value.runDir);
  }
  throw new Error(`找不到任务：${runId}`);
}
export function openRun(runId: string, readonly = false): RunStore { return new RunStore(resolveRunDir(runId), { readonly }); }
function newRunId(): string { return `${new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")}-${randomUUID().slice(0, 8)}`; }

export async function initializeRun(configPath?: string): Promise<string> {
  const config = loadConfig(configPath);
  const sellerInput = config.source.format === "seller_ids_b"
    ? await readSellerIdsColumnB(config.source.path, config.source.sheet, config.amazon.marketplace, config.amazon.marketplaceId, config.source.limit)
    : config.source.format === "seller_links_de"
      ? await readStoreSeeds(config.source.path, config.source.sheet, config.amazon.marketplace, config.amazon.marketplaceId, config.source.limit)
      : undefined;
  const productInput = config.source.format === "asin_links_b"
    ? await readAsinProductLinks(config.source.path, config.source.sheet, config.amazon.marketplace, config.source.limit)
    : undefined;
  const input = sellerInput ?? productInput;
  if (!input) throw new Error(`不支持的输入格式：${config.source.format}`);
  const runId = newRunId();
  const runDir = path.join(config.output.root, "runs", runId);
  const store = new RunStore(runDir);
  try {
    store.initialize(runId, config, input.sourceHash, sellerInput?.seeds ?? [], input.stats, undefined, productInput?.products ?? []);
    appendEvent(runDir, "run_initialized", { runId, sourcePath: config.source.path, sourceHash: input.sourceHash, sourceStats: input.stats });
    writeSummary(store);
    registerRun(runId, runDir);
    console.log(`任务编号：${runId}`);
    return runId;
  } finally { store.close(); }
}

async function withRun(runId: string, command: (store: RunStore) => Promise<number>): Promise<number> {
  const store = openRun(runId);
  try { return await command(store); } finally { store.close(); }
}
export async function storesCommand(runId: string): Promise<number> { return withRun(runId, runStoreStage); }
export async function sourceResolutionCommand(runId: string): Promise<number> { return withRun(runId, runSourceResolutionStage); }
export async function prefilterCommand(runId: string): Promise<number> { return withRun(runId, runPrefilterStage); }
export async function historyFilterCommand(runId: string): Promise<number> { return withRun(runId, runHistoryFilterStage); }
export async function enrichCommand(runId: string): Promise<number> { return withRun(runId, runEnrichmentStage); }
export async function filterCommand(runId: string): Promise<number> { return withRun(runId, runFilterStage); }
export async function sales7dCommand(runId: string): Promise<number> { return withRun(runId, runSales7dStage); }
export async function detailCommand(runId: string): Promise<number> { return withRun(runId, runDetailStage); }

export async function exportCommand(runId: string): Promise<number> {
  return withRun(runId, async (store) => {
    try {
      store.setStage("export", "running");
      const file = await writeExcelExport(store);
      store.setStage("export", "completed");
      const partial = store.source.isPartial() || store.stores.failedStores().length > 0;
      store.source.markExported(!partial);
      appendEvent(store.runDir, "export_completed", { file: path.basename(file), rows: store.exports.count(), partial });
      writeSummary(store);
      console.log(`导出文件：${file}`);
      return partial ? 2 : 0;
    } catch (error) {
      store.setStage("export", "failed", truncateError(error));
      appendEvent(store.runDir, "export_failed", { error: truncateError(error) });
      writeSummary(store);
      return 1;
    }
  });
}

export function statusCommand(runId: string, json = false): number {
  const store = openRun(runId, true);
  try {
    const summary = store.summary();
    console.log(json ? JSON.stringify(summary, null, 2) : formatChineseStatus(summary));
    return 0;
  } finally { store.close(); }
}
