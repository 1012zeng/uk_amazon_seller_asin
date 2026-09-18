import { detailCommand, enrichCommand, exportCommand, filterCommand, historyFilterCommand, initializeRun, prefilterCommand, sales7dCommand, sourceResolutionCommand, storesCommand } from "./app.js";

export interface PipelineOptions { configPath?: string; resumeRunId?: string }
export interface PipelineCommands {
  initialize: (configPath?: string) => Promise<string>;
  sourceResolution: (runId: string) => Promise<number>;
  stores: (runId: string) => Promise<number>;
  prefilter: (runId: string) => Promise<number>;
  historyFilter: (runId: string) => Promise<number>;
  enrich: (runId: string) => Promise<number>;
  filter: (runId: string) => Promise<number>;
  sales7d: (runId: string) => Promise<number>;
  detail: (runId: string) => Promise<number>;
  export: (runId: string) => Promise<number>;
}
const defaults: PipelineCommands = { initialize: initializeRun, sourceResolution: sourceResolutionCommand, stores: storesCommand, prefilter: prefilterCommand, historyFilter: historyFilterCommand, enrich: enrichCommand, filter: filterCommand, sales7d: sales7dCommand, detail: detailCommand, export: exportCommand };

export async function pipelineCommand(options: PipelineOptions, commands: PipelineCommands = defaults): Promise<number> {
  const runId = options.resumeRunId ?? await commands.initialize(options.configPath);
  let partial = false;
  const sourceResolution = await commands.sourceResolution(runId);
  if (sourceResolution === 1 || sourceResolution === 2 || sourceResolution === 130) return sourceResolution;
  partial = sourceResolution === 3;
  const stores = await commands.stores(runId);
  if (stores === 1 || stores === 130) return stores;
  partial ||= stores === 2;
  for (const stage of [commands.prefilter, commands.historyFilter, commands.enrich, commands.filter, commands.sales7d, commands.detail]) {
    const code = await stage(runId);
    if (code !== 0) return code;
  }
  const exported = await commands.export(runId);
  if (exported === 1) return 1;
  partial ||= exported === 2;
  console.log(`${partial ? "流水线部分完成" : "流水线全部完成"}，任务编号：${runId}`);
  return partial ? 2 : 0;
}
