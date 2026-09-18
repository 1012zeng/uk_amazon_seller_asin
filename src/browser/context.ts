import type { Browser, BrowserContext, Page, Response } from "playwright";
import type { AppConfig } from "../shared/types.js";
import { sleep } from "../shared/utils.js";

const CONTEXT_CLOSE_TIMEOUT_MS = 5_000;
const POSTCODE_INPUT_TIMEOUT_MS = 15_000;

export interface AmazonContext {
  context: BrowserContext;
  page: Page;
  proxyPort: number;
}

export type AmazonStorageState = Awaited<ReturnType<BrowserContext["storageState"]>>;

type CurrencyContext = Pick<BrowserContext, "addCookies" | "clearCookies" | "cookies">;

interface PostcodeUpdateResponse {
  isValidAddress?: unknown;
  isAddressUpdated?: unknown;
  successful?: unknown;
}

interface PostcodePageDiagnostics {
  path: string;
  title: string;
  locationButtonVisible: boolean;
  postcodeInputAttached: boolean;
  dialogVisible: boolean;
  captchaVisible: boolean;
  blockMarker: boolean;
}

export class AmazonPostcodeUiUnavailableError extends Error {
  readonly code = "AMAZON_POSTCODE_UI_UNAVAILABLE";

  constructor(proxyPort: number, diagnostics: PostcodePageDiagnostics) {
    super(`Amazon postcode UI unavailable on proxy port ${proxyPort}: ${JSON.stringify(diagnostics)}`);
    this.name = "AmazonPostcodeUiUnavailableError";
  }
}

export function isAmazonPostcodeUiUnavailable(error: unknown): error is AmazonPostcodeUiUnavailableError {
  return error instanceof AmazonPostcodeUiUnavailableError
    || Boolean(error && typeof error === "object" && "code" in error
      && (error as { code?: unknown }).code === "AMAZON_POSTCODE_UI_UNAVAILABLE");
}

function cleanLocationText(value: string | null | undefined): string {
  return (value ?? "").replace(/[\u200b-\u200f\u202a-\u202e]/g, "").replace(/\s+/g, " ").trim();
}

function expectedPostcodePrefix(config: AppConfig): string {
  return config.amazon.postcode.slice(0, -2).trim().toUpperCase();
}

function comparablePostcodeText(value: string | null | undefined): string {
  return cleanLocationText(value).replace(/\s+/g, "").toUpperCase();
}

async function postcodeIsRendered(page: Page, config: AppConfig, timeout: number): Promise<boolean> {
  const displayedLocation = await page.locator("#glow-ingress-line2").first().textContent({ timeout }).catch(() => "");
  return comparablePostcodeText(displayedLocation).includes(comparablePostcodeText(expectedPostcodePrefix(config)));
}

function confirmed(value: unknown): boolean {
  return value === true || value === 1;
}

async function postcodePageDiagnostics(page: Page): Promise<PostcodePageDiagnostics> {
  const visible = (selector: string): Promise<boolean> => page.locator(selector).first().isVisible().catch(() => false);
  let path = "<unavailable>";
  try { path = new URL(page.url()).pathname; }
  catch { /* Keep the diagnostic usable when navigation detached the page. */ }
  const title = await page.title().then((value) => value.replace(/\s+/g, " ").trim().slice(0, 120)).catch(() => "<unavailable>");
  const bodyText = await page.locator("body").innerText({ timeout: 1_000 }).catch(() => "");
  return {
    path,
    title,
    locationButtonVisible: await visible("#nav-global-location-popover-link"),
    postcodeInputAttached: await page.locator("#GLUXZipUpdateInput").count().then((count) => count > 0).catch(() => false),
    dialogVisible: await visible("[role='dialog'], .a-popover"),
    captchaVisible: await visible("#captchacharacters, form[action*='validateCaptcha']"),
    blockMarker: /service unavailable|robot check|verify that you.re not a robot/i.test(`${title} ${bodyText}`),
  };
}

export async function configureAmazonCurrency(context: CurrencyContext, config: AppConfig): Promise<void> {
  const marketplaceHost = new URL(config.amazon.marketplace).hostname;
  const cookieHost = marketplaceHost.replace(/^www\./, "");
  const cookieDomain = `.${cookieHost}`;
  const domainPattern = new RegExp(`(^|\\.)${cookieHost.replaceAll(".", "\\.")}$`);
  await context.clearCookies({ name: "i18n-prefs", domain: domainPattern });
  await context.addCookies([{ name: "i18n-prefs", value: config.amazon.currency, domain: cookieDomain, path: "/", secure: true, sameSite: "Lax" }]);
  const cookies = (await context.cookies(config.amazon.marketplace)).filter((cookie) => cookie.name === "i18n-prefs");
  if (cookies.length !== 1 || cookies[0]?.value !== config.amazon.currency || cookies[0]?.domain !== cookieDomain) throw new Error(`Amazon currency cookie must be ${config.amazon.currency}`);
}

export async function configureAmazonPostcode(page: Page, config: AppConfig, proxyPort: number): Promise<void> {
  await page.waitForLoadState("load", { timeout: config.browser.navigationTimeoutMs });
  const rejectCookies = page.locator("#sp-cc-rejectall-link");
  if (await rejectCookies.isVisible().catch(() => false)) {
    await rejectCookies.click({ force: true });
    await rejectCookies.waitFor({ state: "hidden", timeout: 5_000 }).catch(() => undefined);
  }

  const locationButton = page.locator("#nav-global-location-popover-link").first();
  await locationButton.waitFor({ state: "visible", timeout: Math.min(15_000, config.browser.navigationTimeoutMs) });
  const postcodeInput = page.locator("#GLUXZipUpdateInput");
  if (!await postcodeInput.isVisible().catch(() => false)) {
    await locationButton.click({ force: true });
  }
  try {
    await postcodeInput.waitFor({ state: "visible", timeout: Math.min(POSTCODE_INPUT_TIMEOUT_MS, config.browser.navigationTimeoutMs) });
  } catch {
    throw new AmazonPostcodeUiUnavailableError(proxyPort, await postcodePageDiagnostics(page));
  }
  await postcodeInput.fill(config.amazon.postcode);

  const responsePromise = page.waitForResponse(
    (response) => {
      try { return new URL(response.url()).pathname === "/portal-migration/hz/glow/address-change"; }
      catch { return false; }
    },
    { timeout: config.browser.navigationTimeoutMs },
  );
  await page.locator("#GLUXZipUpdate").click();
  const response = await responsePromise;
  let payload: PostcodeUpdateResponse;
  try { payload = await response.json() as PostcodeUpdateResponse; }
  catch { throw new Error(`Amazon postcode setup failed on proxy port ${proxyPort}: address endpoint returned invalid JSON (HTTP ${response.status()})`); }
  if (response.status() !== 200 || !confirmed(payload.isValidAddress) || !confirmed(payload.isAddressUpdated) || !confirmed(payload.successful)) {
    throw new Error(`Amazon postcode setup failed on proxy port ${proxyPort}: address endpoint did not confirm the address update (HTTP ${response.status()})`);
  }

  await page.waitForTimeout(750);
  const closeConfirmation = page.locator("#GLUXConfirmClose");
  if (await closeConfirmation.isVisible().catch(() => false)) await closeConfirmation.click();
  await reload(page, config, Date.now() + config.browser.navigationTimeoutMs);
  const expectedPrefix = expectedPostcodePrefix(config);
  if (!await postcodeIsRendered(page, config, config.browser.navigationTimeoutMs)) {
    throw new Error(`Amazon postcode setup failed on proxy port ${proxyPort}: delivery location did not render ${expectedPrefix}`);
  }
}

async function hasBlockMarkers(page: Page, status: number): Promise<boolean> {
  return page.evaluate((responseStatus) => {
    const text = `${document.title} ${document.body?.innerText ?? ""}`;
    return responseStatus === 429 || responseStatus === 503
      || responseStatus === 202
      || Boolean(document.querySelector("#captchacharacters, form[action*='validateCaptcha']"))
      || Boolean(document.querySelector("#challenge-container"))
      || Boolean(document.querySelector("[data-aws-waf-token]"))
      || typeof (window as unknown as { AwsWafIntegration?: unknown }).AwsWafIntegration === "object"
      || /service unavailable|robot check|verify that you.re not a robot/i.test(text);
  }, status);
}

async function reload(page: Page, config: AppConfig, deadline: number): Promise<Response | null> {
  while (true) {
    try {
      return await page.reload({ waitUntil: "domcontentloaded", timeout: config.browser.navigationTimeoutMs });
    } catch (error) {
      if (!/ERR_ABORTED|detached|aborted|interrupted|ERR_CONNECTION_CLOSED|ERR_CONNECTION_REFUSED|ERR_CONNECTION_RESET|ECONNREFUSED|ECONNRESET/i.test(String(error)) || Date.now() >= deadline) throw error;
      await sleep(500);
    }
  }
}

async function navigate(page: Page, url: string, config: AppConfig): Promise<Response | null> {
  const deadline = Date.now() + config.browser.navigationTimeoutMs;
  while (true) {
    try {
      return await page.goto(url, { waitUntil: "domcontentloaded", timeout: config.browser.navigationTimeoutMs });
    } catch (error) {
      if (!/ERR_ABORTED|detached|aborted|interrupted|ERR_CONNECTION_CLOSED|ERR_CONNECTION_REFUSED|ERR_CONNECTION_RESET|ECONNREFUSED|ECONNRESET/i.test(String(error)) || Date.now() >= deadline) throw error;
      await sleep(500);
    }
  }
}

async function initializeAmazonSession(context: BrowserContext, page: Page, config: AppConfig, proxyPort: number): Promise<void> {
  await configureAmazonCurrency(context, config);
  let response = await navigate(page, `${config.amazon.marketplace}/`, config);
  let status = response?.status() ?? 0;
  const deadline = Date.now() + config.browser.wafWaitSeconds * 1_000;
  while (await hasBlockMarkers(page, status)) {
    if (Date.now() >= deadline) throw new Error(`Amazon WAF did not clear on proxy port ${proxyPort}; HTTP ${status || "unknown"}`);
    await sleep(1_000);
    response = await reload(page, config, deadline);
    status = response?.status() ?? 0;
  }
  if (!await postcodeIsRendered(page, config, 2_000)) await configureAmazonPostcode(page, config, proxyPort);
  await navigate(page, `${config.amazon.marketplace}${config.browser.controlPath}`, config);
}

export async function refreshAmazonSession(amazon: AmazonContext, config: AppConfig): Promise<void> {
  await initializeAmazonSession(amazon.context, amazon.page, config, amazon.proxyPort);
}

export async function createAmazonContext(browser: Browser, config: AppConfig, proxyPort: number, storageState?: AmazonStorageState): Promise<AmazonContext> {
  const context = await browser.newContext({
    proxy: { server: `http://127.0.0.1:${proxyPort}` },
    locale: "en-GB",
    timezoneId: "Europe/London",
    bypassCSP: true,
    ...(storageState ? { storageState } : {}),
  });
  try {
    await context.route("**/*", async (route) => {
      if (["image", "media", "font"].includes(route.request().resourceType())) await route.abort();
      else await route.continue();
    });
    const page = await context.newPage();
    page.setDefaultTimeout(config.browser.navigationTimeoutMs);
    await initializeAmazonSession(context, page, config, proxyPort);
    return { context, page, proxyPort };
  } catch (error) {
    await Promise.race([
      context.close().catch(() => undefined),
      sleep(CONTEXT_CLOSE_TIMEOUT_MS),
    ]);
    throw error;
  }
}
