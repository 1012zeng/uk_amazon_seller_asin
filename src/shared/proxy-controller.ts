import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ukProjectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../亚马逊爬取V2-TS+PY/seller-sprite-poc");

function runController(args: readonly string[]): { status: number; stderr: string } {
  const result = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", "--import", "tsx", path.join(ukProjectRoot, "src", "proxy-controller-cli.ts"), ...args], {
    cwd: ukProjectRoot,
    encoding: "utf8",
    timeout: 180_000,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  return { status: result.status ?? 1, stderr: String(result.stderr ?? "").trim().slice(-800) };
}

/** Reconcile the UK-owned store ports before a browser context is created. */
export function ensureStoreProxyGeneration(): void {
  const config = path.join(ukProjectRoot, "proxy-controller.yaml");
  const check = runController(["check", "--market", "uk", "--json", "--config", config]);
  if (check.status === 0) return;
  const reconcile = runController(["reconcile", "--market", "uk", "--reason", "scheduled", "--if-stale", "--json", "--config", config]);
  if (reconcile.status !== 0) throw new Error(`代理启动前协调失败（uk）：${reconcile.stderr || "代理协调器未能发布可用 generation"}`);
}

export function reportStoreProxyFailure(port: number, reason: string): void {
  const config = path.join(ukProjectRoot, "proxy-controller.yaml");
  const slot = `amazon-uk-${String(port - 7900).padStart(2, "0")}`;
  runController(["report-failure", "--market", "uk", "--slot", slot, "--failure-reason", reason.slice(0, 240), "--json", "--config", config]);
}

export function readStoreProxyGeneration(): { generationId: string; subscriptionFingerprint: string; updatedAt: string } | null {
  const statePath = path.join(process.env.LOCALAPPDATA ?? path.join(process.env.USERPROFILE ?? ".", "AppData", "Local"), "AmazonProxyController", "state.json");
  if (!existsSync(statePath)) return null;
  try {
    const raw = JSON.parse(readFileSync(statePath, "utf8")) as { current?: { generationId?: unknown; subscriptionFingerprint?: unknown }; updatedAt?: unknown };
    const generationId = raw.current?.generationId;
    const subscriptionFingerprint = raw.current?.subscriptionFingerprint;
    return typeof generationId === "string" && typeof subscriptionFingerprint === "string"
      ? { generationId, subscriptionFingerprint, updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : "" }
      : null;
  } catch { return null; }
}
