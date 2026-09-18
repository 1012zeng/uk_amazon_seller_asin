import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { chineseEventMessage, formatChineseStatus, operatorErrorMessage } from "../../src/shared/logging.js";
import { appendEvent } from "../../src/shared/utils.js";

afterEach(() => vi.restoreAllMocks());

describe("中文日志", () => {
  it("在终端和事件文件中写入中文消息，同时保留机器事件码", () => {
    const runDir = mkdtempSync(path.join(tmpdir(), "amazon-log-"));
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      appendEvent(runDir, "store_page_success", {
        sellerId: "A123456789",
        crawlRound: 1,
        page: 2,
        results: 16,
        concurrency: 3,
      });
      const event = JSON.parse(readFileSync(path.join(runDir, "events.jsonl"), "utf8")) as Record<string, unknown>;
      expect(event.type).toBe("store_page_success");
      expect(event.message).toBe("店铺 A123456789 第 1 轮第 2 页 抓取成功，获得 16 条商品，当前并发 3。");
      expect(output).toHaveBeenCalledWith(expect.stringContaining(String(event.message)));
      expect(output.mock.calls[0]?.[0]).not.toContain("store_page_success");
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }
  });

  it("能够翻译卖家解析阶段复用的浏览器事件", () => {
    expect(chineseEventMessage("source_resolution_store_recovery_started", { proxyPort: 7901 }))
      .toBe("卖家解析：浏览器会话异常，开始自动恢复（代理端口 7901）。");
  });

  it("在新品销量日志中显示固定日均门槛", () => {
    expect(chineseEventMessage("sales_7d_completed", { dailySalesMinimum: 3, outcome: "retained" }))
      .toBe("一个新品的日均 3 单校验已完成，是否保留：是。");
    expect(chineseEventMessage("sales_7d_stage_completed", { dailySalesMinimum: 3, cleanedProducts: 8 }))
      .toBe("新品日均 3 单校验阶段已完成，当前保留 8 个商品。");
  });

  it("把常见续跑错误翻译成可执行的中文说明", () => {
    expect(operatorErrorMessage(new Error("Resume refused: source Excel SHA-256 changed")))
      .toBe("拒绝续跑：源 Excel 内容已经改变，请恢复原文件或创建新任务。");
    expect(operatorErrorMessage(new Error("命令无效，可用命令包含 sales-7d")))
      .toBe("命令无效，可用命令包含 sales-7d");
  });

  it("状态摘要默认展示中文阶段和中文状态", () => {
    const report = formatChineseStatus({
      runId: "run-1",
      status: "running",
      currentStage: "stores",
      complete: false,
      partial: false,
      integrity: "ok",
      stages: [
        { stage: "import", status: "completed", error: "" },
        { stage: "stores", status: "running", error: "" },
      ],
      sourceResolution: { counts: { resolved: 20, failed: 1 }, uniqueStores: 10 },
      stores: { occurrences: 32, completeness: { totalStores: 10, exactCompleted: 2, verifiedDriftCompleted: 1, quarantined: 0 } },
      cleanedProducts: 5,
    });
    expect(report).toContain("当前阶段：抓取店铺商品");
    expect(report).toContain("- 读取输入文件：已完成");
    expect(report).toContain("- 抓取店铺商品：正在运行");
    expect(report).toContain("- 店铺处理进度：3/10（30.0%）");
    expect(report).toContain("- 完整店铺：3");
  });
});
