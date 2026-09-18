import { detailCommand, enrichCommand, exportCommand, filterCommand, historyFilterCommand, prefilterCommand, sales7dCommand, sourceResolutionCommand, statusCommand, storesCommand } from "./app.js";
import { pipelineCommand } from "./pipeline.js";
import { operatorErrorMessage } from "./shared/logging.js";

class UsageError extends Error {}
function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new UsageError(`参数 ${name} 后面必须提供值`);
  return value;
}
function requiredRun(args: string[]): string {
  const runId = option(args, "--run") ?? option(args, "--resume");
  if (!runId) throw new UsageError("该命令必须提供 --run <任务编号>");
  return runId;
}

async function main(): Promise<number> {
  const [command, ...args] = process.argv.slice(2);
  if (command === "pipeline") {
    const resumeRunId = option(args, "--resume");
    const configPath = option(args, "--config");
    if (resumeRunId && configPath) throw new UsageError("流水线只能使用 --resume 或 --config，不能同时使用");
    return pipelineCommand({ ...(resumeRunId ? { resumeRunId } : {}), ...(configPath ? { configPath } : {}) });
  }
  if (command === "stores") return storesCommand(requiredRun(args));
  if (command === "source-resolution") return sourceResolutionCommand(requiredRun(args));
  if (command === "prefilter") return prefilterCommand(requiredRun(args));
  if (command === "history-filter") return historyFilterCommand(requiredRun(args));
  if (command === "enrich") return enrichCommand(requiredRun(args));
  if (command === "filter") return filterCommand(requiredRun(args));
  if (command === "sales-7d") return sales7dCommand(requiredRun(args));
  if (command === "detail") return detailCommand(requiredRun(args));
  if (command === "export") return exportCommand(requiredRun(args));
  if (command === "status") return statusCommand(requiredRun(args), args.includes("--json"));
  throw new UsageError("命令无效，可用命令：pipeline、source-resolution、stores、prefilter、history-filter、enrich、filter、sales-7d、detail、export、status");
}

main().then((code) => { process.exitCode = code; }).catch((error: unknown) => {
  console.error(`运行失败：${operatorErrorMessage(error)}`);
  process.exitCode = 1;
});
