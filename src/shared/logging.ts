import type { StageName, StageStatus } from "./types.js";

type EventPayload = Record<string, unknown>;

const STAGE_NAMES: Record<StageName, string> = {
  import: "读取输入文件",
  source_resolution: "解析商品卖家",
  stores: "抓取店铺商品",
  prefilter: "商品初筛",
  history_filter: "排除历史商品",
  enrich: "卖家精灵竞品补全",
  filter: "商品二次筛选",
  sales_7d: "新品七日销量校验",
  detail: "商品详情补全",
  export: "导出 Excel",
};

const STATUS_NAMES: Record<StageStatus, string> = {
  pending: "等待开始",
  running: "正在运行",
  completed: "已完成",
  partial: "部分完成",
  failed: "失败",
  paused: "已暂停，可继续运行",
};

function text(payload: EventPayload, key: string, fallback = ""): string {
  const value = payload[key];
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function number(payload: EventPayload, key: string, fallback = 0): number {
  const value = payload[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function yesNo(value: unknown): string {
  return value ? "是" : "否";
}

function pageTarget(payload: EventPayload): string {
  const sellerId = text(payload, "sellerId", "未知店铺");
  const round = number(payload, "crawlRound", 1);
  const page = number(payload, "page", 1);
  return `店铺 ${sellerId} 第 ${round} 轮第 ${page} 页`;
}

function runtimeMessage(type: string, payload: EventPayload): string | null {
  const port = number(payload, "proxyPort");
  const portText = port > 0 ? `（代理端口 ${port}）` : "";
  switch (type) {
    case "store_session_state_loaded": return `已载入浏览器会话${portText}。`;
    case "store_session_state_load_failed": return `浏览器会话载入失败${portText}，将创建新会话。`;
    case "store_session_state_saved": return `已保存浏览器会话${portText}。`;
    case "store_session_state_save_failed": return `浏览器会话保存失败${portText}，本次运行仍会继续。`;
    case "store_context_ready": return `亚马逊浏览器已就绪${portText}。`;
    case "store_startup_session_state_preferred": return `优先使用已有浏览器会话${portText}。`;
    case "store_context_unavailable": return `亚马逊浏览器启动失败${portText}，正在尝试下一个代理。`;
    case "store_reprobe_session_reused": return `正在复用当前浏览器会话复查异常页面${portText}。`;
    case "store_recovery_started": return `浏览器会话异常，开始自动恢复${portText}。`;
    case "store_postcode_ui_endpoint_rejected": return `当前代理无法设置英国邮编，正在切换恢复方案${portText}。`;
    case "store_session_refreshed": return `浏览器会话已刷新${portText}。`;
    case "store_browser_restarted": return `浏览器已重新启动${portText}。`;
    case "store_proxy_switched": return `已切换代理${portText}。`;
    case "store_refresh_failed": return `浏览器会话刷新失败${portText}，继续尝试恢复。`;
    case "store_restart_failed": return `浏览器重启失败${portText}，继续尝试恢复。`;
    case "store_proxy_failed": return `代理切换失败${portText}，继续尝试其他代理。`;
    default: return null;
  }
}

export function stageName(stage: unknown): string {
  return typeof stage === "string" && stage in STAGE_NAMES ? STAGE_NAMES[stage as StageName] : "未知阶段";
}

export function stageStatusName(status: unknown): string {
  return typeof status === "string" && status in STATUS_NAMES ? STATUS_NAMES[status as StageStatus] : "未知状态";
}

export function beijingLogTime(timestamp: string): string {
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(new Date(timestamp));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute}:${values.second}`;
}

export function operatorErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? "");
  if (/Resume refused: static configuration hash changed/i.test(raw)) return "拒绝续跑：任务创建后的配置内容已经改变，请恢复原配置或创建新任务。";
  if (/Resume refused: source Excel SHA-256 changed/i.test(raw)) return "拒绝续跑：源 Excel 内容已经改变，请恢复原文件或创建新任务。";
  if (/Resume refused: run contract changed/i.test(raw)) return "拒绝续跑：任务运行合同已经改变，请创建新任务。";
  if (/Run schema .* incompatible/i.test(raw)) return "旧任务数据库与当前程序版本不兼容，只能只读查看；请创建新任务运行。";
  if (/Source Excel does not exist/i.test(raw)) return "配置指定的源 Excel 不存在，请检查文件路径。";
  if (/[㐀-鿿]/u.test(raw)) return raw;
  if (/Invalid .*config|Config value|contract cannot be changed|must remain|must keep|must satisfy|must contain|Filtering rules/i.test(raw)) {
    return `配置校验失败，请恢复项目规定的固定配置。技术原文：${raw}`;
  }
  if (/History database/i.test(raw)) return `历史数据库配置或返回数据异常，流程没有绕过历史排除。技术原文：${raw}`;
  if (/proxy|browser|WAF|postcode|Content-Type|Content-Length|Response exceeds/i.test(raw)) {
    return `亚马逊浏览器、代理或页面响应异常，自动恢复未能完成。技术原文：${raw}`;
  }
  if (/SellerSprite|MCP|Lookup batch|sales-7d|ASIN detail/i.test(raw)) {
    return `卖家精灵补全服务或返回数据异常，当前任务进度已保留。技术原文：${raw}`;
  }
  if (/Excel|Export/i.test(raw)) return `Excel 读取或导出失败，未生成不完整的正式结果。技术原文：${raw}`;
  if (/requires completed|not terminal|ledger is not terminal|Store snapshot is sealed/i.test(raw)) {
    return `前置阶段尚未正确完成，当前命令不能继续。技术原文：${raw}`;
  }
  return `发生未能自动翻译的技术错误，运行已停止。技术原文：${raw || "无"}`;
}

export function chineseEventMessage(originalType: string, payload: EventPayload = {}): string {
  const sourceResolutionRuntime = originalType.startsWith("source_resolution_store_");
  const type = sourceResolutionRuntime ? originalType.slice("source_resolution_".length) : originalType;
  const scope = sourceResolutionRuntime ? "卖家解析：" : "";
  const runtime = runtimeMessage(type, payload);
  if (runtime) return `${scope}${runtime}`;

  switch (type) {
    case "run_initialized": return `任务已创建，任务编号：${text(payload, "runId", "未知")}。`;
    case "stage_started": return `${stageName(payload.stage)}：正在运行。`;
    case "source_product_seller_resolved":
      return `商品 ${text(payload, "asin", "未知")} 已解析到卖家 ${text(payload, "sellerId", "未知")}。`;
    case "source_product_seller_resolution_failed":
      return `商品 ${text(payload, "asin", "未知")} 的卖家解析失败，已尝试 ${number(payload, "attempts")} 次。`;
    case "source_resolution_completed":
      return `商品卖家解析结束，共得到 ${number(payload, "uniqueStores")} 个唯一店铺；是否存在失败项：${yesNo(payload.partial)}。`;
    case "source_resolution_failed": return "商品卖家解析失败，没有得到可继续抓取的店铺。";
    case "source_resolution_paused": return "商品卖家解析已暂停，当前进度已保存，可使用同一任务编号继续。";
    case "store_concurrency_reduced": return `检测到访问异常，店铺抓取并发已降至 ${number(payload, "concurrency")}。`;
    case "store_pagination_baseline_frozen":
      return `店铺 ${text(payload, "sellerId", "未知")} 的分页边界已确认。`;
    case "store_page_validation_warning":
      return `${pageTarget(payload)} 出现数据波动警告，已保留校验证据。`;
    case "store_page_retry": return `${pageTarget(payload)} 校验未通过，已安排重试。`;
    case "store_page_reprobe_scheduled": return `${pageTarget(payload)} 出现轻微波动，已安排独立复查。`;
    case "store_page_quarantined": return `${pageTarget(payload)} 抓取失败，其余计划页继续；存在失败页的店铺不会进入后续筛选。`;
    case "store_page_success":
      return `${pageTarget(payload)} 抓取成功，获得 ${number(payload, "results")} 条商品，当前并发 ${number(payload, "concurrency")}。`;
    case "duplicate_store_page_result": return `${pageTarget(payload)} 的重复结果已忽略。`;
    case "store_page_reprobe_started": return `开始复查店铺 ${text(payload, "sellerId", "未知")} 第 ${number(payload, "page", 1)} 页。`;
    case "store_page_reprobe_verified": return `${pageTarget(payload)} 复查通过，可以继续处理。`;
    case "store_page_reprobe_failure": return `店铺 ${text(payload, "sellerId", "未知")} 第 ${number(payload, "page", 1)} 页复查失败，已按不完整结果处理。`;
    case "store_page_failure": return `${pageTarget(payload)} 抓取失败，系统将按重试和隔离规则处理。`;
    case "store_page_peer_requeued": return `${pageTarget(payload)} 因浏览器恢复被中断，已重新排队。`;
    case "stores_completed": return `店铺抓取结束；是否存在不完整店铺：${yesNo(payload.partial)}。`;
    case "stores_paused": return "店铺抓取已暂停，当前进度已保存，可使用同一任务编号继续。";
    case "stores_failed": return "店铺抓取阶段失败，已保存现场和技术错误。";
    case "prefilter_completed":
      return `商品初筛完成，共形成 ${number(payload, "uniqueCandidates")} 个唯一候选商品。`;
    case "prefilter_failed": return "商品初筛失败，数据库原始抓取记录未被删除。";
    case "history_filter_skipped": return "按当前 Seller ID 独立任务合同，已跳过历史数据库排除。";
    case "history_filter_completed":
      return `历史商品排除完成：命中 ${number(payload, "excluded")} 个，剩余 ${number(payload, "eligibleForMcp")} 个待补全。`;
    case "history_filter_paused": return "历史数据库旁路阶段异常，流程已暂停并保留当前进度。";
    case "mcp_batch_started":
      return `卖家精灵第 ${number(payload, "round")} 轮第 ${number(payload, "batchOrdinal")} 批开始，共 ${number(payload, "count")} 个商品。`;
    case "mcp_batch_completed":
      return `卖家精灵第 ${number(payload, "round")} 轮第 ${number(payload, "batchOrdinal")} 批完成：成功 ${number(payload, "successes")} 个，未找到 ${number(payload, "notFound")} 个。`;
    case "mcp_round2_stopped": return `卖家精灵第二轮已按空批次规则停止，跳过 ${number(payload, "skipped")} 个任务。`;
    case "enrichment_completed": return "卖家精灵竞品补全阶段已完成。";
    case "enrichment_paused": return "卖家精灵竞品补全失败，流程已暂停，批次进度已保存。";
    case "filter_completed": return `商品二次筛选完成，当前保留 ${number(payload, "cleanedProducts")} 个商品。`;
    case "filter_failed": return "商品二次筛选失败，流程已停止。";
    case "sales_7d_completed": return `一个新品的日均 ${number(payload, "dailySalesMinimum")} 单校验已完成，是否保留：${text(payload, "outcome") === "retained" ? "是" : "否"}。`;
    case "sales_7d_stage_completed": return `新品日均 ${number(payload, "dailySalesMinimum")} 单校验阶段已完成，当前保留 ${number(payload, "cleanedProducts")} 个商品。`;
    case "sales_7d_paused": return "新品七日销量校验失败，流程已暂停，任务进度已保存。";
    case "asin_detail_completed": return `一个商品的详情补全已完成；取得五点：${yesNo(payload.hasFeatures)}，取得详情：${yesNo(payload.hasOverviews)}。`;
    case "asin_detail_stage_completed": return `商品详情补全阶段已完成，最终保留 ${number(payload, "cleanedProducts")} 个商品。`;
    case "asin_detail_paused": return "商品详情补全失败，流程已暂停，任务进度已保存。";
    case "export_completed":
      return `Excel 导出完成：${text(payload, "file", "结果文件")}，共 ${number(payload, "rows")} 行；是否为部分结果：${yesNo(payload.partial)}。`;
    case "export_failed": return "Excel 导出失败，未生成不完整的正式文件。";
    default: return `${scope}系统状态已更新，详细结构化信息已写入事件文件。`;
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function formatChineseStatus(summary: Record<string, unknown>): string {
  const sourceResolution = record(summary.sourceResolution);
  const resolutionCounts = record(sourceResolution.counts);
  const stores = record(summary.stores);
  const completeness = record(stores.completeness);
  const totalStores = Number(completeness.totalStores ?? 0);
  const completedStores = Number(completeness.exactCompleted ?? 0) + Number(completeness.verifiedDriftCompleted ?? 0);
  const processedStores = completedStores + Number(completeness.quarantined ?? 0);
  const storeProgress = totalStores > 0 ? `${((processedStores / totalStores) * 100).toFixed(1)}%` : "0.0%";
  const integrity = summary.integrity === "ok" ? "正常" : "异常";
  const overall = summary.complete ? "全部完成" : summary.partial ? "尚未全部完成，已有部分结果" : stageStatusName(summary.status);
  const lines = [
    "任务运行状态",
    `任务编号：${String(summary.runId ?? "未知")}`,
    `总体状态：${overall}`,
    `当前阶段：${stageName(summary.currentStage)}`,
    `数据库完整性：${integrity}`,
    "",
    "阶段进度：",
  ];
  const stages = Array.isArray(summary.stages) ? summary.stages : [];
  for (const value of stages) {
    const stage = record(value);
    const hasError = typeof stage.error === "string" && stage.error.length > 0;
    lines.push(`- ${stageName(stage.stage)}：${stageStatusName(stage.status)}${hasError ? "（存在错误，技术原文已保留）" : ""}`);
  }
  lines.push(
    "",
    "关键数量：",
    `- 已解析商品卖家：${Number(resolutionCounts.resolved ?? 0)}`,
    `- 卖家解析失败：${Number(resolutionCounts.failed ?? 0)}`,
    `- 唯一店铺：${Number(sourceResolution.uniqueStores ?? 0)}`,
    `- 店铺处理进度：${processedStores}/${totalStores}（${storeProgress}）`,
    `- 完整店铺：${completedStores}`,
    `- 已隔离店铺：${Number(completeness.quarantined ?? 0)}`,
    `- 页面原始商品记录：${Number(stores.rawOccurrences ?? stores.occurrences ?? 0)}`,
    `- ${Number(summary.schemaVersion ?? 0) >= 14 ? "ASIN 去重后落库记录" : "已落库商品记录"}：${Number(stores.occurrences ?? 0)}`,
    `- 最终保留商品：${Number(summary.cleanedProducts ?? 0)}`,
    "",
    "结构化原始状态仍保存在 summary.json；逐条中文进度保存在 events.jsonl 的 message 字段。",
  );
  return lines.join("\n");
}
