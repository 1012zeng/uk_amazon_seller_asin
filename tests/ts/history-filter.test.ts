import { describe, expect, it } from "vitest";
import { runHistoryFilterStage } from "../../src/stages/history-filter.js";
import { runFixture, seedCandidates } from "./helpers.js";

describe("history stage contract", () => {
  it("skips the historical database and leaves all candidates eligible", async () => {
    const { store } = runFixture();
    const asins = seedCandidates(store, 2, false);
    expect(await runHistoryFilterStage(store)).toBe(0);
    expect(store.source.stageStatus("history_filter")).toBe("completed");
    expect(store.candidates.listAsinsByState("history_excluded")).toEqual([]);
    expect(store.candidates.listAsinsByState("mcp_pending")).toEqual(asins);
    store.close();
  });
});
