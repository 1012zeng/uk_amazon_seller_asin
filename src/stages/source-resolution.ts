import { parseProductSellerDocument } from "../amazon/product-seller.js";
import { fetchDocument } from "../browser/fetch.js";
import { StoreBrowserRuntime } from "../browser/store-runtime.js";
import { StartRateLimiter } from "../browser/store-scheduler.js";
import type { RunStore } from "../database/run-store.js";
import type { AppConfig, ProductSellerResult, SourceProductTask } from "../shared/types.js";
import { appendEvent, truncateError, writeSummary } from "../shared/utils.js";

export interface ProductSellerResolver {
  start(): Promise<void>;
  resolve(task: SourceProductTask): Promise<ProductSellerResult>;
  recover(cause: unknown): Promise<void>;
  close(): Promise<void>;
}

class BrowserProductSellerResolver implements ProductSellerResolver {
  private readonly runtime: StoreBrowserRuntime;

  constructor(private readonly config: AppConfig, runDir: string) {
    this.runtime = new StoreBrowserRuntime(config, (event, payload) => appendEvent(runDir, `source_resolution_${event}`, payload), runDir);
  }

  start(): Promise<void> { return this.runtime.start(); }

  async resolve(task: SourceProductTask): Promise<ProductSellerResult> {
    const document = await this.runtime.withNoResponseTimeout(() => fetchDocument(
      this.runtime.amazon.page,
      task.productUrl,
      this.config.browser.requestTimeoutMs,
      this.config.stores.maxResponseBytes,
    ));
    return parseProductSellerDocument(document, this.config.amazon.marketplace);
  }

  recover(cause: unknown): Promise<void> { return this.runtime.recover(cause); }
  close(): Promise<void> { return this.runtime.close(); }
}

function finalizeResolution(store: RunStore): number {
  const counts = store.sourceResolution.counts();
  const failed = store.sourceResolution.failedCount();
  const resolved = store.sourceResolution.resolvedProductCount();
  const uniqueStores = store.sourceResolution.uniqueStoreCount();
  store.source.updateSourceStats({
    resolvedProductLinks: resolved,
    resolutionFailed: failed,
    uniqueStores,
    duplicateResolvedSellers: Math.max(0, resolved - uniqueStores),
  });
  if (uniqueStores === 0) {
    const error = "No seller stores were resolved from the ASIN product links";
    store.setStage("source_resolution", "failed", error);
    appendEvent(store.runDir, "source_resolution_failed", { counts, error });
    writeSummary(store);
    return 1;
  }
  const partial = failed > 0;
  store.source.setPartial(store.source.isPartial() || partial);
  store.setStage("source_resolution", partial ? "partial" : "completed");
  appendEvent(store.runDir, "source_resolution_completed", { counts, uniqueStores, partial });
  writeSummary(store);
  return partial ? 3 : 0;
}

export async function runSourceResolutionStage(store: RunStore, resolver?: ProductSellerResolver): Promise<number> {
  const config = store.getRunConfig();
  if (config.source.format === "seller_links_de") {
    if (store.source.stageStatus("source_resolution") !== "completed") throw new Error("Seller-link source must initialize source_resolution as completed");
    return 0;
  }
  const currentStatus = store.source.stageStatus("source_resolution");
  if (currentStatus === "completed") return 0;
  if (currentStatus === "partial") return 3;
  if (currentStatus === "failed") return 1;
  if (store.source.stageStatus("import") !== "completed") throw new Error("Source resolution requires completed import stage");
  if (store.sourceResolution.isTerminal()) return finalizeResolution(store);

  const activeResolver = resolver ?? new BrowserProductSellerResolver(config, store.runDir);
  const limiter = new StartRateLimiter(config.stores.requestsPerSecond);
  let interrupted = false;
  const onInterrupt = (): void => { interrupted = true; };
  process.once("SIGINT", onInterrupt);
  store.setStage("source_resolution", "running");

  try {
    await activeResolver.start();
    while (!interrupted) {
      const task = store.sourceResolution.pending(1)[0];
      if (!task) break;
      await limiter.acquire();
      try {
        const result = await activeResolver.resolve(task);
        if (result.kind === "success") {
          const applied = store.sourceResolution.applyResolved(task, result);
          appendEvent(store.runDir, "source_product_seller_resolved", {
            asin: task.asin,
            sourceRow: task.sourceRow,
            sellerId: result.sellerId,
            insertedStore: applied.insertedStore,
            httpStatus: result.httpStatus,
            responseBytes: result.responseBytes,
            fetchMs: result.fetchMs,
          });
          continue;
        }
        const failed = store.sourceResolution.applyFailure(task, result.error);
        appendEvent(store.runDir, "source_product_seller_resolution_failed", {
          asin: task.asin,
          sourceRow: task.sourceRow,
          kind: result.kind,
          state: failed.state,
          attempts: failed.attempts,
          httpStatus: result.httpStatus,
          error: result.error,
        });
        if (result.kind === "blocked") await activeResolver.recover(result.error);
      } catch (error) {
        const failed = store.sourceResolution.applyFailure(task, truncateError(error));
        appendEvent(store.runDir, "source_product_seller_resolution_failed", {
          asin: task.asin,
          sourceRow: task.sourceRow,
          kind: "error",
          state: failed.state,
          attempts: failed.attempts,
          error: truncateError(error),
        });
        await activeResolver.recover(error);
      }
    }

    if (interrupted) {
      store.setStage("source_resolution", "paused", "Interrupted by Ctrl+C");
      appendEvent(store.runDir, "source_resolution_paused", { reason: "SIGINT" });
      writeSummary(store);
      return 130;
    }
    if (!store.sourceResolution.isTerminal()) throw new Error("Source resolution ledger is not terminal");
    return finalizeResolution(store);
  } catch (error) {
    store.setStage("source_resolution", "paused", truncateError(error));
    appendEvent(store.runDir, "source_resolution_paused", { error: truncateError(error) });
    writeSummary(store);
    return 2;
  } finally {
    process.removeListener("SIGINT", onInterrupt);
    await activeResolver.close().catch(() => undefined);
  }
}
