import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { RunStore } from "../database/run-store.js";
import { beijingLogTime, chineseEventMessage } from "./logging.js";

export function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function truncateError(error: unknown): string {
  return (error instanceof Error ? error.stack || error.message : String(error ?? "")).slice(0, 4_000);
}

export function appendEvent(runDir: string, type: string, payload: Record<string, unknown> = {}): void {
  mkdirSync(runDir, { recursive: true });
  const timestamp = new Date().toISOString();
  const message = chineseEventMessage(type, payload);
  appendFileSync(path.join(runDir, "events.jsonl"), `${JSON.stringify({ timestamp, type, ...payload, message })}\n`, "utf8");
  console.log(`[北京时间 ${beijingLogTime(timestamp)}] ${message}`);
}

export function writeSummary(store: RunStore): void {
  writeFileSync(path.join(store.runDir, "summary.json"), `${JSON.stringify(store.summary(), null, 2)}\n`, "utf8");
}

export function randomDelay(minimum: number, maximum: number): number {
  return minimum + Math.floor(Math.random() * (maximum - minimum + 1));
}
