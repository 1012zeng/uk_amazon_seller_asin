import type { RunStore } from "../database/run-store.js";
import { fixedSales7dWindow, SellerSpriteClient } from "../mcp/client.js";
import { appendEvent, truncateError, writeSummary } from "../shared/utils.js";

export async function runSales7dStage(store: RunStore, client: Pick<SellerSpriteClient, "health" | "sales7d"> = new SellerSpriteClient(store.getRunConfig())): Promise<number> {
  try {
    if (store.source.stageStatus("filter") !== "completed") throw new Error("Sales-7d requires completed filter stage");
    store.setStage("sales_7d", "running");
    const window = fixedSales7dWindow(store.getAsOfDate());
    const dailySalesMinimum = store.getRunConfig().filters.newListingDailySalesMinimum;
    store.sales.materialize(window.asOfDate, window.windowStart, window.windowEnd, dailySalesMinimum);
    if (store.sales.hasWork()) await client.health();
    for (;;) {
      const task = store.sales.next();
      if (!task) break;
      try {
        const result = await client.sales7d(task.asin, window.asOfDate, task.dailySalesMinimum);
        if (result.dailySalesMinimum !== task.dailySalesMinimum) throw new Error("Sales-7d result used a different daily minimum");
        const outcome = store.sales.complete(task.asin, result);
        appendEvent(store.runDir, "sales_7d_completed", { outcome, result: result.result, dailySalesMinimum: task.dailySalesMinimum, complete: result.complete });
      } catch (error) {
        store.sales.fail(task.asin, error);
        throw error;
      }
    }
    if (!store.sales.isTerminal()) throw new Error("Sales-7d tasks are not terminal");
    store.setStage("sales_7d", "completed");
    appendEvent(store.runDir, "sales_7d_stage_completed", { window, dailySalesMinimum, counts: store.sales.counts(), thresholds: store.sales.thresholdCounts(), cleanedProducts: store.exports.count() });
    writeSummary(store);
    return 0;
  } catch (error) {
    store.setStage("sales_7d", "paused", truncateError(error));
    appendEvent(store.runDir, "sales_7d_paused", { error: truncateError(error) });
    writeSummary(store);
    return 2;
  }
}
