import type { RunStore } from "../database/run-store.js";
import { appendEvent, truncateError, writeSummary } from "../shared/utils.js";

export async function runHistoryFilterStage(
  store: RunStore,
  _client?: unknown,
): Promise<number> {
  try {
    if (store.source.stageStatus("prefilter") !== "completed") throw new Error("History filter requires completed prefilter stage");
    if (store.source.stageStatus("history_filter") === "completed") return 0;
    store.setStage("history_filter", "running");
    const pendingAsins = store.candidates.listAsinsByState("mcp_pending");
    if (store.getRunConfig().historyFilter.enabled) throw new Error("历史库在独立卖家 ID 项目中必须关闭");
    const counts = store.completeHistoryFilter(new Set());
    appendEvent(store.runDir, "history_filter_skipped", { ...counts, pendingAsins: pendingAsins.length, reason: "independent_seller_ids_source_contract" });
    writeSummary(store);
    return 0;
  } catch (error) {
    store.setStage("history_filter", "paused", truncateError(error));
    appendEvent(store.runDir, "history_filter_paused", { error: truncateError(error) });
    writeSummary(store);
    return 2;
  }
}
