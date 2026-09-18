import type { RunStore } from "../database/run-store.js";
import { HistoryDatabaseClient, type HistoryAsinLookup } from "../history/client.js";
import { appendEvent, truncateError, writeSummary } from "../shared/utils.js";

export async function runHistoryFilterStage(
  store: RunStore,
  client?: HistoryAsinLookup,
): Promise<number> {
  try {
    if (store.source.stageStatus("prefilter") !== "completed") throw new Error("History filter requires completed prefilter stage");
    if (store.source.stageStatus("history_filter") === "completed") return 0;
    store.setStage("history_filter", "running");
    const pendingAsins = store.candidates.listAsinsByState("mcp_pending");
    if (!store.getRunConfig().historyFilter.enabled) {
      const counts = store.completeHistoryFilter(new Set());
      appendEvent(store.runDir, "history_filter_skipped", { ...counts, reason: "asin_links_b_source_contract" });
      writeSummary(store);
      return 0;
    }
    const existingAsins = await (client ?? new HistoryDatabaseClient()).findExistingAsins(pendingAsins);
    const counts = store.completeHistoryFilter(existingAsins);
    appendEvent(store.runDir, "history_filter_completed", counts);
    writeSummary(store);
    return 0;
  } catch (error) {
    store.setStage("history_filter", "paused", truncateError(error));
    appendEvent(store.runDir, "history_filter_paused", { error: truncateError(error) });
    writeSummary(store);
    return 2;
  }
}
