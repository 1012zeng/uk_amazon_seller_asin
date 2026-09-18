import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import type { AppConfig, SourceFormat } from "./types.js";

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid config section: ${label}`);
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && !value.trim())) throw new Error(`Invalid config value: ${label}`);
  return value.trim();
}

function number(value: unknown, label: string, min = 0): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min) throw new Error(`Invalid numeric config value: ${label}`);
  return value;
}

function integer(value: unknown, label: string, min = 0): number {
  const result = number(value, label, min);
  if (!Number.isInteger(result)) throw new Error(`Config value must be an integer: ${label}`);
  return result;
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`Invalid boolean config value: ${label}`);
  return value;
}

function ports(value: unknown, label: string): number[] {
  if (!Array.isArray(value) || value.some((item) => !Number.isInteger(item) || item < 1 || item > 65_535)) throw new Error(`Invalid proxy ports: ${label}`);
  return value as number[];
}

function resolveProjectPath(value: string): string {
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(projectRoot, value);
}

export function loadConfig(configFile = "config/amazon-uk.yaml"): AppConfig {
  const configPath = resolveProjectPath(configFile);
  const sourceText = readFileSync(configPath, "utf8");
  const raw = object(YAML.parse(sourceText), "root");
  const source = object(raw.source, "source");
  const historyFilter = object(raw.historyFilter ?? { enabled: true }, "historyFilter");
  const amazon = object(raw.amazon, "amazon");
  const browser = object(raw.browser, "browser");
  const stores = object(raw.stores, "stores");
  const storeConcurrency = object(stores.concurrency, "stores.concurrency");
  const paginationValidation = object(stores.paginationValidation ?? {
    softTotalDriftRatio: 0.05, softTotalDriftAbsolute: 5, hardTotalDriftRatio: 0.2, hardTotalDriftAbsolute: 20,
    softLastPageDriftRatio: 0.05, softLastPageDriftAbsolute: 1, hardLastPageDriftRatio: 0.2, hardLastPageDriftAbsolute: 2,
    overlapReprobeRatio: 0.2, rangeCardTolerance: 1, fallbackPageMultiplier: 2, fallbackPageMargin: 2, fallbackMaxPages: 400,
  }, "stores.paginationValidation");
  const sellerSprite = object(raw.sellerSprite, "sellerSprite");
  const filters = object(raw.filters, "filters");
  const output = object(raw.output, "output");
  if (Object.hasOwn(filters, "minPredictedSales7dExclusive")) throw new Error("filters.minPredictedSales7dExclusive was removed; sales-7d filtering uses exact result=yes or No");

  const config: AppConfig = {
    projectRoot,
    configPath,
    configHash: createHash("sha256").update(sourceText).digest("hex"),
    source: {
      path: resolveProjectPath(string(source.path, "source.path")),
      sheet: string(source.sheet, "source.sheet"),
      limit: integer(source.limit, "source.limit"),
      format: string(source.format ?? "seller_links_de", "source.format") as SourceFormat,
    },
    historyFilter: { enabled: boolean(historyFilter.enabled, "historyFilter.enabled") },
    amazon: {
      marketplace: string(amazon.marketplace, "amazon.marketplace").replace(/\/$/, ""),
      site: string(amazon.site, "amazon.site"),
      marketplaceId: string(amazon.marketplaceId, "amazon.marketplaceId"),
      postcode: string(amazon.postcode, "amazon.postcode"),
      currency: string(amazon.currency, "amazon.currency").toUpperCase() as "GBP",
    },
    browser: {
      headed: browser.headed !== false,
      executablePath: string(browser.executablePath ?? "", "browser.executablePath", true),
      controlPath: string(browser.controlPath, "browser.controlPath"),
      navigationTimeoutMs: integer(browser.navigationTimeoutMs, "browser.navigationTimeoutMs", 1_000),
      requestTimeoutMs: integer(browser.requestTimeoutMs, "browser.requestTimeoutMs", 1_000),
      wafWaitSeconds: integer(browser.wafWaitSeconds, "browser.wafWaitSeconds"),
      pageRefreshAttempts: integer(browser.pageRefreshAttempts ?? 1, "browser.pageRefreshAttempts", 1),
      browserRestartAttempts: integer(browser.browserRestartAttempts ?? 2, "browser.browserRestartAttempts", 1),
      noResponseTimeoutMs: integer(browser.noResponseTimeoutMs ?? 60_000, "browser.noResponseTimeoutMs", 1_000),
      recoveryDelayMs: integer(browser.recoveryDelayMs ?? 5_000, "browser.recoveryDelayMs"),
    },
    stores: {
      concurrency: {
        initial: integer(storeConcurrency.initial, "stores.concurrency.initial", 1),
        min: integer(storeConcurrency.min, "stores.concurrency.min", 1),
        max: integer(storeConcurrency.max, "stores.concurrency.max", 1),
        successWindowPages: integer(storeConcurrency.successWindowPages, "stores.concurrency.successWindowPages", 1),
        cooldownMs: integer(storeConcurrency.cooldownMs, "stores.concurrency.cooldownMs"),
      },
      requestsPerSecond: number(stores.requestsPerSecond, "stores.requestsPerSecond", 0.1),
      maxResponseBytes: integer(stores.maxResponseBytes, "stores.maxResponseBytes", 1),
      maxRetries: integer(stores.maxRetries, "stores.maxRetries", 1),
      maxBlockedAttempts: integer(stores.maxBlockedAttempts, "stores.maxBlockedAttempts", 1),
      blockedDelayMs: integer(stores.blockedDelayMs, "stores.blockedDelayMs"),
      maxPagesPerStore: integer(stores.maxPagesPerStore, "stores.maxPagesPerStore"),
      paginationValidation: {
        softTotalDriftRatio: number(paginationValidation.softTotalDriftRatio, "stores.paginationValidation.softTotalDriftRatio"),
        softTotalDriftAbsolute: integer(paginationValidation.softTotalDriftAbsolute, "stores.paginationValidation.softTotalDriftAbsolute"),
        hardTotalDriftRatio: number(paginationValidation.hardTotalDriftRatio, "stores.paginationValidation.hardTotalDriftRatio"),
        hardTotalDriftAbsolute: integer(paginationValidation.hardTotalDriftAbsolute, "stores.paginationValidation.hardTotalDriftAbsolute"),
        softLastPageDriftRatio: number(paginationValidation.softLastPageDriftRatio, "stores.paginationValidation.softLastPageDriftRatio"),
        softLastPageDriftAbsolute: integer(paginationValidation.softLastPageDriftAbsolute, "stores.paginationValidation.softLastPageDriftAbsolute"),
        hardLastPageDriftRatio: number(paginationValidation.hardLastPageDriftRatio, "stores.paginationValidation.hardLastPageDriftRatio"),
        hardLastPageDriftAbsolute: integer(paginationValidation.hardLastPageDriftAbsolute, "stores.paginationValidation.hardLastPageDriftAbsolute"),
        overlapReprobeRatio: number(paginationValidation.overlapReprobeRatio, "stores.paginationValidation.overlapReprobeRatio"),
        rangeCardTolerance: integer(paginationValidation.rangeCardTolerance, "stores.paginationValidation.rangeCardTolerance"),
        fallbackPageMultiplier: integer(paginationValidation.fallbackPageMultiplier, "stores.paginationValidation.fallbackPageMultiplier", 1),
        fallbackPageMargin: integer(paginationValidation.fallbackPageMargin, "stores.paginationValidation.fallbackPageMargin"),
        fallbackMaxPages: integer(paginationValidation.fallbackMaxPages, "stores.paginationValidation.fallbackMaxPages", 1),
      },
      proxyPorts: ports(stores.proxyPorts, "stores.proxyPorts"),
    },
    sellerSprite: {
      serviceUrl: string(sellerSprite.serviceUrl, "sellerSprite.serviceUrl").replace(/\/$/, ""),
      marketplace: string(sellerSprite.marketplace, "sellerSprite.marketplace").toUpperCase(),
      batchSize: integer(sellerSprite.batchSize, "sellerSprite.batchSize", 1),
      requestTimeoutMs: integer(sellerSprite.requestTimeoutMs, "sellerSprite.requestTimeoutMs", 1_000),
    },
    filters: {
      maxReviewCount: integer(filters.maxReviewCount, "filters.maxReviewCount"),
      minRatingInclusive: number(filters.minRatingInclusive, "filters.minRatingInclusive"),
      minPricePence: integer(filters.minPricePence, "filters.minPricePence"),
      maxPricePence: integer(filters.maxPricePence, "filters.maxPricePence"),
      maxVariations: integer(filters.maxVariations, "filters.maxVariations"),
      maxNewAgeDays: integer(filters.maxNewAgeDays, "filters.maxNewAgeDays"),
      firstChildSalesBandMaxAgeDays: integer(filters.firstChildSalesBandMaxAgeDays, "filters.firstChildSalesBandMaxAgeDays"),
      secondChildSalesBandMaxAgeDays: integer(filters.secondChildSalesBandMaxAgeDays, "filters.secondChildSalesBandMaxAgeDays"),
      maxAgeDays: integer(filters.maxAgeDays, "filters.maxAgeDays"),
      firstChildSalesBandMinimum: integer(filters.firstChildSalesBandMinimum, "filters.firstChildSalesBandMinimum"),
      secondChildSalesBandMinimum: integer(filters.secondChildSalesBandMinimum, "filters.secondChildSalesBandMinimum"),
      thirdChildSalesBandMinimum: integer(filters.thirdChildSalesBandMinimum, "filters.thirdChildSalesBandMinimum"),
      newListingDailySalesMinimum: integer(filters.newListingDailySalesMinimum, "filters.newListingDailySalesMinimum", 1),
    },
    output: { root: resolveProjectPath(string(output.root, "output.root")) },
  };

  if (config.amazon.marketplace !== "https://www.amazon.co.uk" || config.amazon.site !== "amazon.co.uk" || config.amazon.marketplaceId !== "A1F83G8C2ARO7P") throw new Error("Amazon UK marketplace contract cannot be changed");
  if (config.amazon.postcode !== "WC1E 7HU") throw new Error("amazon.postcode must remain WC1E 7HU");
  if (config.amazon.currency !== "GBP") throw new Error("amazon.currency must remain GBP");
  if (config.source.format !== "seller_links_de" && config.source.format !== "asin_links_b") throw new Error("source.format must be seller_links_de or asin_links_b");
  if (config.source.format === "seller_links_de" && !config.historyFilter.enabled) throw new Error("seller_links_de runs must keep historyFilter.enabled=true");
  if (config.source.format === "asin_links_b" && config.historyFilter.enabled) throw new Error("asin_links_b runs must set historyFilter.enabled=false");
  if (!path.isAbsolute(config.source.path) || !existsSync(config.source.path)) throw new Error(`Source Excel does not exist: ${config.source.path}`);
  const concurrency = config.stores.concurrency;
  if (concurrency.min > concurrency.initial || concurrency.initial > concurrency.max || concurrency.max !== 3) throw new Error("stores.concurrency must satisfy min <= initial <= max, with max fixed at 3");
  if (config.stores.proxyPorts.length !== 4) throw new Error("stores.proxyPorts must contain the four ordered failover ports");
  const pagination = config.stores.paginationValidation;
  if (pagination.softTotalDriftRatio > pagination.hardTotalDriftRatio || pagination.softTotalDriftAbsolute > pagination.hardTotalDriftAbsolute
    || pagination.softLastPageDriftRatio > pagination.hardLastPageDriftRatio || pagination.softLastPageDriftAbsolute > pagination.hardLastPageDriftAbsolute
    || pagination.overlapReprobeRatio <= 0 || pagination.overlapReprobeRatio >= 1) {
    throw new Error("stores.paginationValidation must keep soft thresholds below hard thresholds and overlapReprobeRatio between 0 and 1");
  }
  if (![2, 3].includes(config.stores.requestsPerSecond) || config.stores.maxResponseBytes !== 5_242_880) throw new Error("Store request contract allows 2 requests/second (or rollout fallback 3) with a 5 MiB response limit");
  if (config.sellerSprite.serviceUrl !== "http://127.0.0.1:8012" || config.sellerSprite.marketplace !== "UK" || config.sellerSprite.batchSize !== 40) throw new Error("SellerSprite contract must remain UK, http://127.0.0.1:8012, batch size 40");
  const expected = config.filters;
  if (expected.maxReviewCount !== 300 || expected.minRatingInclusive !== 3.5 || expected.minPricePence !== 699 || expected.maxPricePence !== 5000 || expected.maxVariations !== 3
    || expected.maxNewAgeDays !== 30 || expected.firstChildSalesBandMaxAgeDays !== 365 || expected.secondChildSalesBandMaxAgeDays !== 550 || expected.maxAgeDays !== 720
    || expected.firstChildSalesBandMinimum !== 100 || expected.secondChildSalesBandMinimum !== 200 || expected.thirdChildSalesBandMinimum !== 300 || expected.newListingDailySalesMinimum !== 3) {
    throw new Error("Filtering rules are part of the run contract and cannot be changed");
  }
  return config;
}
