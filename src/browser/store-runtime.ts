import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium, type Browser } from "playwright";
import type { AppConfig, StoreRuntimeMetrics } from "../shared/types.js";
import { sleep, truncateError } from "../shared/utils.js";
import { createAmazonContext, isAmazonPostcodeUiUnavailable, refreshAmazonSession, type AmazonContext, type AmazonStorageState } from "./context.js";
import { prioritizeProxyIndices, recoveryPlan, SingleFlight } from "./store-scheduler.js";
import { ensureStoreProxyGeneration, reportStoreProxyFailure } from "../shared/proxy-controller.js";

type EventWriter = (event: string, payload: Record<string, unknown>) => void;

function storageState(value: unknown): AmazonStorageState | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as { cookies?: unknown; origins?: unknown };
  return Array.isArray(candidate.cookies) && Array.isArray(candidate.origins) ? candidate as AmazonStorageState : null;
}

export class StoreBrowserRuntime {
  private browser: Browser | null = null;
  private session: AmazonContext | null = null;
  private readonly sessionStates = new Map<number, AmazonStorageState>();
  private proxyIndex = 0;
  private generationValue = 0;
  private readonly recoverySingleFlight = new SingleFlight();
  private readonly counters: StoreRuntimeMetrics = {
    browserContexts: 0, browserPages: 0, maxObservedConcurrency: 0, p95FetchMs: 0,
    refreshCount: 0, restartCount: 0, proxySwitchCount: 0,
  };

  constructor(private readonly config: AppConfig, private readonly writeEvent: EventWriter, private readonly sessionStateDir?: string) {}

  get amazon(): AmazonContext {
    if (!this.session) throw new Error("Amazon browser session is unavailable");
    return this.session;
  }

  get generation(): number { return this.generationValue; }
  get endpointPort(): number { return this.amazon.proxyPort; }
  metrics(): StoreRuntimeMetrics { return { ...this.counters }; }

  observeConcurrency(inFlight: number): void {
    this.counters.maxObservedConcurrency = Math.max(this.counters.maxObservedConcurrency, inFlight);
  }

  setP95FetchMs(value: number): void { this.counters.p95FetchMs = value; }

  private sessionStatePath(proxyPort: number): string | null {
    return this.sessionStateDir ? path.join(this.sessionStateDir, "browser-sessions", `${proxyPort}.json`) : null;
  }

  private loadSessionState(proxyPort: number): AmazonStorageState | undefined {
    const cached = this.sessionStates.get(proxyPort);
    if (cached) return cached;
    const filePath = this.sessionStatePath(proxyPort);
    if (!filePath || !existsSync(filePath)) return undefined;
    try {
      const loaded = storageState(JSON.parse(readFileSync(filePath, "utf8")));
      if (!loaded) throw new Error("invalid storage-state shape");
      this.sessionStates.set(proxyPort, loaded);
      this.writeEvent("store_session_state_loaded", { proxyPort });
      return loaded;
    } catch (error) {
      this.writeEvent("store_session_state_load_failed", { proxyPort, error: truncateError(error) });
      return undefined;
    }
  }

  private hasSessionState(proxyPort: number): boolean {
    const filePath = this.sessionStatePath(proxyPort);
    return this.sessionStates.has(proxyPort) || Boolean(filePath && existsSync(filePath));
  }

  private async saveSessionState(session: AmazonContext): Promise<void> {
    try {
      const state = await session.context.storageState();
      this.sessionStates.set(session.proxyPort, state);
      const filePath = this.sessionStatePath(session.proxyPort);
      if (!filePath) return;
      mkdirSync(path.dirname(filePath), { recursive: true });
      const temporary = `${filePath}.${process.pid}.tmp`;
      writeFileSync(temporary, `${JSON.stringify(state)}\n`, "utf8");
      renameSync(temporary, filePath);
      this.writeEvent("store_session_state_saved", { proxyPort: session.proxyPort });
    } catch (error) {
      this.writeEvent("store_session_state_save_failed", { proxyPort: session.proxyPort, error: truncateError(error) });
    }
  }

  private async closeCurrent(): Promise<void> {
    const session = this.session;
    const browser = this.browser;
    this.session = null;
    this.browser = null;
    if (session) await this.saveSessionState(session);
    if (session) await Promise.race([session.context.close().catch(() => undefined), sleep(5_000)]);
    if (browser) await Promise.race([browser.close().catch(() => undefined), sleep(5_000)]);
  }

  private async launchAt(index: number): Promise<void> {
    await this.closeCurrent();
    const port = this.config.stores.proxyPorts[index];
    if (!port) throw new Error(`Missing proxy port at failover index ${index}`);
    const browser = await chromium.launch({
      headless: !this.config.browser.headed,
      ...(this.config.browser.executablePath ? { executablePath: this.config.browser.executablePath } : {}),
    });
    this.browser = browser;
    try {
      this.session = await createAmazonContext(browser, this.config, port, this.loadSessionState(port));
      await this.saveSessionState(this.session);
      this.proxyIndex = index;
      this.counters.browserContexts = Math.max(this.counters.browserContexts, 1);
      this.counters.browserPages = Math.max(this.counters.browserPages, 1);
      this.writeEvent("store_context_ready", { proxyPort: port, failoverIndex: index });
    } catch (error) {
      await this.closeCurrent();
      throw error;
    }
  }

  async start(): Promise<void> {
    ensureStoreProxyGeneration();
    let lastError: unknown = new Error("No proxy ports configured");
    const indices = prioritizeProxyIndices(this.config.stores.proxyPorts, (proxyPort) => this.hasSessionState(proxyPort));
    if (indices[0] !== 0) {
      this.writeEvent("store_startup_session_state_preferred", { proxyPort: this.config.stores.proxyPorts[indices[0]!] });
    }
    for (let attempt = 0; attempt < indices.length; attempt += 1) {
      const index = indices[attempt]!;
      if (attempt > 0) this.counters.proxySwitchCount += 1;
      try {
        await this.launchAt(index);
        return;
      } catch (error) {
        lastError = error;
        this.writeEvent("store_context_unavailable", { proxyPort: this.config.stores.proxyPorts[index], error: truncateError(error), initial: true });
      }
    }
    throw new Error(`All store proxy endpoints are unavailable: ${truncateError(lastError)}`);
  }

  async withNoResponseTimeout<T>(operation: () => Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Browser request produced no response within ${this.config.browser.noResponseTimeoutMs} ms`)), this.config.browser.noResponseTimeoutMs);
    });
    try { return await Promise.race([operation(), timeout]); }
    finally { if (timer) clearTimeout(timer); }
  }

  recover(cause: unknown): Promise<void> {
    return this.recoverySingleFlight.run(async () => {
      this.generationValue += 1;
      await this.performRecovery(cause);
    });
  }

  prepareForReprobe(cause: unknown): void {
    this.writeEvent("store_reprobe_session_reused", {
      proxyPort: this.endpointPort,
      cause: truncateError(cause),
    });
  }

  private async performRecovery(cause: unknown): Promise<void> {
    this.writeEvent("store_recovery_started", { proxyPort: this.config.stores.proxyPorts[this.proxyIndex], cause: truncateError(cause) });
    const postcodeUiUnavailable = isAmazonPostcodeUiUnavailable(cause);
    const actions = recoveryPlan(
      this.proxyIndex,
      this.config.stores.proxyPorts.length,
      this.config.browser.pageRefreshAttempts,
      this.config.browser.browserRestartAttempts,
      postcodeUiUnavailable,
    );
    if (postcodeUiUnavailable) {
      this.writeEvent("store_postcode_ui_endpoint_rejected", { proxyPort: this.config.stores.proxyPorts[this.proxyIndex] });
    }
    for (let actionIndex = 0; actionIndex < actions.length; actionIndex += 1) {
      const action = actions[actionIndex]!;
      try {
        if (action.kind === "refresh") {
          this.counters.refreshCount += 1;
          await refreshAmazonSession(this.amazon, this.config);
          this.writeEvent("store_session_refreshed", { proxyPort: this.endpointPort, attempt: actionIndex + 1 });
        } else {
          if (action.kind === "restart") this.counters.restartCount += 1;
          else this.counters.proxySwitchCount += 1;
          await this.launchAt(action.proxyIndex);
          this.writeEvent(action.kind === "restart" ? "store_browser_restarted" : "store_proxy_switched", { proxyPort: this.endpointPort, failoverIndex: action.proxyIndex });
        }
        return;
      } catch (error) {
        this.writeEvent(`store_${action.kind}_failed`, { proxyPort: this.config.stores.proxyPorts[action.proxyIndex], error: truncateError(error) });
        if (action.kind === "restart" && this.config.browser.recoveryDelayMs > 0) await sleep(this.config.browser.recoveryDelayMs);
      }
    }
    try { reportStoreProxyFailure(this.config.stores.proxyPorts[this.proxyIndex]!, truncateError(cause)); } catch (error) {
      this.writeEvent("store_proxy_failure_report_failed", { proxyPort: this.config.stores.proxyPorts[this.proxyIndex], error: truncateError(error) });
    }
    throw new Error("Store browser recovery exhausted every proxy endpoint");
  }

  async close(): Promise<void> {
    this.generationValue += 1;
    await this.closeCurrent();
  }
}
