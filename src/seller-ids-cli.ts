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

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const resumeRunId = option(args, "--resume");
  const configPath = option(args, "--config") ?? "config/amazon-uk.local.yaml";
  if (resumeRunId && args.includes("--config")) throw new UsageError("Seller ID 流水线只能使用 --resume 或 --config，不能同时使用");
  return pipelineCommand(resumeRunId ? { resumeRunId } : { configPath });
}

main().then((code) => { process.exitCode = code; }).catch((error: unknown) => {
  console.error(`运行失败：${operatorErrorMessage(error)}`);
  process.exitCode = 1;
});
