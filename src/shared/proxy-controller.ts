import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { AppConfig } from "./types.js";

function controllerRoot(config: AppConfig): string {
  return path.resolve(config.stores.proxyControllerPath);
}

export interface ProxyControllerCommandResult {
  status: number;
  stderr: string;
}

export type ProxyControllerCommandRunner = (root: string, args: readonly string[]) => ProxyControllerCommandResult;

function runController(root: string, args: readonly string[]): ProxyControllerCommandResult {
  const result = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", "--import", "tsx", path.join(root, "src", "proxy-controller-cli.ts"), ...args], {
    cwd: root,
    encoding: "utf8",
    timeout: 180_000,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  return { status: result.status ?? 1, stderr: String(result.stderr ?? "").trim().slice(-800) };
}

function sleepSync(milliseconds: number): void {
  if (milliseconds <= 0) return;
  const signal = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(signal, 0, 0, milliseconds);
}

export interface ProxyControllerRetryOptions {
  maxAttempts?: number;
  retryDelayMs?: number;
  run?: ProxyControllerCommandRunner;
  sleep?: (milliseconds: number) => void;
}

export function isProxyControllerLockError(result: ProxyControllerCommandResult): boolean {
  return /(?:ELOCKED|lock file is already being held)/iu.test(result.stderr);
}

/** Retry only the shared-controller lock collision; configuration errors remain fail-fast. */
export function runProxyControllerWithRetry(
  root: string,
  args: readonly string[],
  options: ProxyControllerRetryOptions = {},
): ProxyControllerCommandResult {
  const maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? 4));
  const retryDelayMs = Math.max(0, Math.floor(options.retryDelayMs ?? 3_000));
  const run = options.run ?? runController;
  const sleep = options.sleep ?? sleepSync;
  let result = run(root, args);
  for (let attempt = 1; attempt < maxAttempts && result.status !== 0 && isProxyControllerLockError(result); attempt += 1) {
    sleep(retryDelayMs);
    result = run(root, args);
  }
  return result;
}

/** Reconcile the UK-owned store ports before a browser context is created. */
export function ensureStoreProxyGeneration(appConfig: AppConfig): void {
  const root = controllerRoot(appConfig);
  const config = path.join(root, "proxy-controller.yaml");
  const check = runController(root, ["check", "--market", "uk", "--json", "--config", config]);
  if (check.status === 0) return;
  const reconcile = runProxyControllerWithRetry(root, ["reconcile", "--market", "uk", "--reason", "scheduled", "--if-stale", "--json", "--config", config]);
  if (reconcile.status !== 0) throw new Error(`代理启动前协调失败（uk）：${reconcile.stderr || "代理协调器未能发布可用 generation"}`);
}

export function reportStoreProxyFailure(appConfig: AppConfig, port: number, reason: string): void {
  const root = controllerRoot(appConfig);
  const config = path.join(root, "proxy-controller.yaml");
  const slot = `amazon-uk-${String(port - 7900).padStart(2, "0")}`;
  runController(root, ["report-failure", "--market", "uk", "--slot", slot, "--failure-reason", reason.slice(0, 240), "--json", "--config", config]);
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
