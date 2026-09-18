import { normalizeStoreSnapshot } from "../amazon/parsing.js";
import { fetchStoreSnapshot } from "../browser/fetch.js";
import { StoreBrowserRuntime } from "../browser/store-runtime.js";
import { AdaptiveConcurrencyController, isPeerRecoveryInterruption, selectDispatchableTasks, StartRateLimiter } from "../browser/store-scheduler.js";
import type { RunStore } from "../database/run-store.js";
import type { StorePageApplyResult, StorePageTask } from "../database/repositories/store-repository.js";
import { appendEvent, sleep, truncateError, writeSummary } from "../shared/utils.js";
import { readStoreProxyGeneration } from "../shared/proxy-controller.js";

function percentile95(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? 0;
}

export async function runStoreStage(store: RunStore): Promise<number> {
  const config = store.getRunConfig();
  if (!["completed", "partial"].includes(store.source.stageStatus("source_resolution"))) throw new Error("Store crawl requires terminal source resolution");
  if (store.storeStageIsTerminal()) {
    const counts = store.storePageCounts();
    const partial = store.stores.failedStores().length > 0;
    store.setStage("stores", partial ? "partial" : "completed");
    appendEvent(store.runDir, "stores_completed", { counts, partial, resumed: true });
    writeSummary(store);
    return partial ? 2 : 0;
  }
  if (store.source.isStoreSnapshotSealed()) throw new Error("Store snapshot is sealed; failed stores require a new run");

  store.setStage("stores", "running");
  const controller = new AdaptiveConcurrencyController(config.stores.concurrency);
  const limiter = new StartRateLimiter(config.stores.requestsPerSecond);
  const runtime = new StoreBrowserRuntime(config, (event, payload) => appendEvent(store.runDir, event, payload), store.runDir);
  const active = new Map<string, Promise<void>>();
  const activeSellers = new Set<string>();
  const fetchDurations: number[] = [];
  let httpInFlight = 0;
  let interrupted = false;
  let fatal: Error | undefined;
  const onInterrupt = (): void => { interrupted = true; };
  process.once("SIGINT", onInterrupt);

  const persistRuntime = (): void => {
    runtime.setP95FetchMs(percentile95(fetchDurations));
    store.source.setStoreRuntimeMetrics(runtime.metrics());
  };

  const recoverSession = async (cause: unknown): Promise<void> => {
    const before = runtime.metrics();
    await runtime.recover(cause);
    const after = runtime.metrics();
    if (after.restartCount > before.restartCount || after.proxySwitchCount > before.proxySwitchCount) {
      const concurrency = controller.onHardFailure();
      appendEvent(store.runDir, "store_concurrency_reduced", { reason: "browser_restart_or_proxy_switch", concurrency });
    }
  };

  async function execute(task: StorePageTask): Promise<void> {
    await limiter.acquire();
    let generation = runtime.generation;
    let endpointPort = runtime.endpointPort;

    const fetchParsed = async (url: string, page: number) => {
      httpInFlight += 1;
      runtime.observeConcurrency(httpInFlight);
      try {
        const snapshot = await runtime.withNoResponseTimeout(() => fetchStoreSnapshot(
          runtime.amazon.page, url, config.browser.requestTimeoutMs, config.stores.maxResponseBytes,
        ));
        fetchDurations.push(snapshot.fetchMs);
        endpointPort = runtime.endpointPort;
        return {
          snapshot,
          parsed: {
            ...normalizeStoreSnapshot(snapshot, task.sellerId, page, config.amazon.marketplace, config.amazon.marketplaceId),
            endpointPort,
          },
        };
      } finally {
        httpInFlight -= 1;
      }
    };

    const recordApplied = (applied: StorePageApplyResult, parsed: ReturnType<typeof normalizeStoreSnapshot>, resultSummaryText: string): void => {
      if (applied.boundary) appendEvent(store.runDir, "store_pagination_baseline_frozen", { sellerId: task.sellerId, ...applied.boundary });
      if (applied.applied && applied.warnings.length > 0) appendEvent(store.runDir, "store_page_validation_warning", { sellerId: task.sellerId, crawlRound: task.crawlRound, page: task.page, warnings: applied.warnings });
      if (["retry", "reprobe", "incomplete"].includes(applied.status)) {
        const concurrency = controller.onSoftFailure();
        const event = applied.status === "reprobe" ? "store_page_reprobe_scheduled" : applied.status === "retry" ? "store_page_retry" : "store_page_quarantined";
        appendEvent(store.runDir, event, { sellerId: task.sellerId, crawlRound: task.crawlRound, page: task.page, reasonCode: applied.reasonCode, reason: applied.reason, resultSummaryText: resultSummaryText.slice(0, 500), concurrency });
        return;
      }
      const concurrency = controller.onSuccess();
      appendEvent(store.runDir, task.mode === "reprobe" ? "store_page_reprobe_verified" : applied.applied ? "store_page_success" : "duplicate_store_page_result", {
        sellerId: task.sellerId, crawlRound: task.crawlRound, page: task.page, results: parsed.occurrences.length, reportedTotal: parsed.reportedTotal,
        visibleLastPage: parsed.visibleLastPage, resultRangeStart: parsed.resultRangeStart, resultRangeEnd: parsed.resultRangeEnd,
        nextUrl: parsed.nextUrl, status: applied.status, endpointPort, fetchMs: parsed.fetchMs, concurrency,
      });
    };

    try {
      if (task.mode === "reprobe") {
        runtime.prepareForReprobe(`Pagination reprobe ${task.sellerId} page ${task.page}`);
        generation = runtime.generation;
        endpointPort = runtime.endpointPort;
        appendEvent(store.runDir, "store_page_reprobe_started", { sellerId: task.sellerId, page: task.page, endpointPort });
        const baseline = await fetchParsed(task.baselineUrl, 1);
        const current = task.page === 1 && task.url === task.baselineUrl ? baseline : await fetchParsed(task.url, task.page);
        if (baseline.parsed.kind !== "success" || current.parsed.kind !== "success") {
          const failed = baseline.parsed.kind !== "success" ? baseline : current;
          const message = `Pagination reprobe failed: ${failed.parsed.error}`;
          const failedKind = failed.parsed.kind === "success" ? "error" : failed.parsed.kind;
          const applied = store.applyStorePageFailure(task.sellerId, task.crawlRound, task.page, failedKind, message, failed === current ? failed.parsed : undefined);
          appendEvent(store.runDir, "store_page_reprobe_failure", { sellerId: task.sellerId, page: task.page, kind: failedKind, outcome: applied.status, error: message, endpointPort });
          if (failed.parsed.kind === "blocked") await recoverSession(message);
          return;
        }
        const applied = store.applyStorePageReprobe(task.sellerId, task.crawlRound, task.page, baseline.parsed, current.parsed);
        recordApplied(applied, current.parsed, current.snapshot.resultSummaryText);
        return;
      }

      const fetched = await fetchParsed(task.url, task.page);
      const { snapshot, parsed } = fetched;
      if (parsed.kind === "success") {
        const applied = store.applyStorePageSuccess(task.sellerId, task.crawlRound, task.page, parsed);
        recordApplied(applied, parsed, snapshot.resultSummaryText);
        return;
      }

      const applied = store.applyStorePageFailure(task.sellerId, task.crawlRound, task.page, parsed.kind, parsed.error, parsed);
      appendEvent(store.runDir, "store_page_failure", { sellerId: task.sellerId, crawlRound: task.crawlRound, page: task.page, kind: parsed.kind, outcome: applied.status, error: parsed.error, endpointPort });
      if (parsed.kind === "blocked") {
        const concurrency = controller.onHardFailure();
        appendEvent(store.runDir, "store_concurrency_reduced", { reason: parsed.kind, concurrency });
        await recoverSession(parsed.error);
      }
    } catch (error) {
      if (isPeerRecoveryInterruption(generation, runtime.generation)) {
        appendEvent(store.runDir, "store_page_peer_requeued", { sellerId: task.sellerId, crawlRound: task.crawlRound, page: task.page, generation, currentGeneration: runtime.generation, error: truncateError(error) });
        return;
      }
      const applied = store.applyStorePageFailure(task.sellerId, task.crawlRound, task.page, "error", error);
      const hard = /HTTP\s+(?:429|503)|captcha|waf|browser.*closed|target page|context.*closed/i.test(String(error));
      const concurrency = hard ? controller.onHardFailure() : controller.onSoftFailure();
      appendEvent(store.runDir, "store_page_failure", { sellerId: task.sellerId, crawlRound: task.crawlRound, page: task.page, kind: "error", outcome: applied.status, error: truncateError(error), endpointPort, concurrency });
      await recoverSession(error);
    }
  }

  try {
    await runtime.start();
    const proxyGeneration = readStoreProxyGeneration();
    appendEvent(store.runDir, "store_proxy_generation_ready", {
      market: "uk",
      generationId: proxyGeneration?.generationId ?? null,
      subscriptionFingerprint: proxyGeneration?.subscriptionFingerprint ?? null,
      updatedAt: proxyGeneration?.updatedAt ?? null,
      healthyAtStartup: true,
    });
    store.source.updateSourceStats({ proxy: { market: "uk", generationId: proxyGeneration?.generationId ?? null, healthyAtStartup: true } });
    while (!interrupted && !fatal && !store.storeStageIsTerminal()) {
      const capacity = Math.max(0, controller.current - active.size);
      if (capacity > 0) {
        const tasks = selectDispatchableTasks(store.pendingStorePages(100), activeSellers, new Set(active.keys()), capacity);
        for (const task of tasks) {
          const key = `${task.sellerId}:${task.crawlRound}:${task.page}`;
          activeSellers.add(task.sellerId);
          const promise = execute(task)
            .catch((error) => { fatal = error instanceof Error ? error : new Error(String(error)); })
            .finally(() => { active.delete(key); activeSellers.delete(task.sellerId); });
          active.set(key, promise);
        }
      }
      if (active.size > 0) await Promise.race([...active.values(), sleep(100)]);
      else await sleep(100);
    }
    await Promise.allSettled(active.values());
    persistRuntime();
    if (fatal) throw fatal;
    if (interrupted) {
      store.setStage("stores", "paused", "Interrupted by Ctrl+C");
      appendEvent(store.runDir, "stores_paused", { reason: "SIGINT" });
      writeSummary(store);
      return 130;
    }
    const counts = store.storePageCounts();
    const partial = store.stores.failedStores().length > 0;
    store.setStage("stores", partial ? "partial" : "completed");
    appendEvent(store.runDir, "stores_completed", { counts, partial, completeness: store.stores.completenessSummary(), runtime: runtime.metrics() });
    writeSummary(store);
    return partial ? 2 : 0;
  } catch (error) {
    persistRuntime();
    const failure = error instanceof Error ? error : new Error(String(error));
    store.setStage("stores", "failed", truncateError(failure));
    appendEvent(store.runDir, "stores_failed", { error: truncateError(failure) });
    writeSummary(store);
    return 1;
  } finally {
    process.removeListener("SIGINT", onInterrupt);
    await runtime.close().catch(() => undefined);
  }
}
