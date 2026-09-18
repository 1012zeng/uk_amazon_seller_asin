import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/shared/config.js";

describe("production config", () => {
  it("pins the Excel source, MCP service and filtering contract", () => {
    const config = loadConfig("config/amazon-uk.yaml");
    expect(config.source).toMatchObject({ sheet: "产品数据", limit: 0, format: "seller_links_de" });
    expect(config.source.path).toMatch(/\.xlsx$/);
    expect(config.historyFilter).toEqual({ enabled: true });
    expect(config.sellerSprite).toMatchObject({ serviceUrl: "http://127.0.0.1:8012", marketplace: "UK", batchSize: 40 });
    expect(config.stores).toMatchObject({ concurrency: { initial: 3, min: 1, max: 3, successWindowPages: 10, cooldownMs: 60_000 }, requestsPerSecond: 2, maxResponseBytes: 5_242_880, proxyPorts: [7901, 7902, 7903, 7904] });
    expect(config.filters).toEqual({
      maxReviewCount: 300, minRatingInclusive: 3.5, minPricePence: 699, maxPricePence: 5000, maxVariations: 3,
      maxNewAgeDays: 30, firstChildSalesBandMaxAgeDays: 365, secondChildSalesBandMaxAgeDays: 550, maxAgeDays: 720,
      firstChildSalesBandMinimum: 100, secondChildSalesBandMinimum: 200, thirdChildSalesBandMinimum: 300, newListingDailySalesMinimum: 3,
    });
  });

  it("loads the SellerSprite cleaning workbook as a standard seller-link source", () => {
    const config = loadConfig("config/amazon-uk-sellersprite-cleaning.yaml");
    expect(config.source).toMatchObject({ sheet: "uk_overall_source_data_table", limit: 0, format: "seller_links_de" });
    expect(config.source.path).toMatch(/20260720新开品清洗数据_with_images\.xlsx$/);
    expect(config.historyFilter).toEqual({ enabled: true });
  });

  it("pins the B-column ASIN-link source and disables history filtering only there", () => {
    const config = loadConfig("config/amazon-uk-asin-links.yaml");
    expect(config.source).toMatchObject({ sheet: "Sheet1", limit: 0, format: "asin_links_b" });
    expect(config.source.path).toMatch(/UK站点ASIN竞品链接清单[^\\/]*\.xlsx$/);
    expect(config.historyFilter).toEqual({ enabled: false });
  });

  it("rejects attempts to cross the source-format and history-filter contracts", () => {
    const production = readFileSync("config/amazon-uk.yaml", "utf8");
    const root = mkdtempSync(path.join(os.tmpdir(), "config-contract-"));
    const disabledSeller = path.join(root, "disabled-seller.yaml");
    const enabledAsin = path.join(root, "enabled-asin.yaml");
    writeFileSync(disabledSeller, production.replace("enabled: true", "enabled: false"));
    writeFileSync(enabledAsin, production.replace("format: \"seller_links_de\"", "format: \"asin_links_b\""));
    expect(() => loadConfig(disabledSeller)).toThrow(/seller_links_de.*enabled=true/);
    expect(() => loadConfig(enabledAsin)).toThrow(/asin_links_b.*enabled=false/);
  });
});
