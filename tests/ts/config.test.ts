import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/shared/config.js";

function fixtureConfig(): { root: string; text: string } {
  const root = mkdtempSync(path.join(os.tmpdir(), "seller-id-config-"));
  const source = path.join(root, "source.xlsx");
  writeFileSync(source, "fixture");
  const sourcePath = source.replaceAll("\\", "/");
  const text = readFileSync("config/amazon-uk.example.yaml", "utf8")
    .replace(/^  path:.*$/m, `  path: "${sourcePath}"`)
    .replace(/^  root:.*$/m, `  root: "${root.replaceAll("\\", "/")}"`);
  return { root, text };
}

describe("independent seller-ID configuration", () => {
  it("pins the B-column source and the new 180-day contract", () => {
    const fixture = fixtureConfig();
    const file = path.join(fixture.root, "config.yaml");
    writeFileSync(file, fixture.text);
    const config = loadConfig(file);
    expect(config.source).toMatchObject({ sheet: "卖家数据", limit: 0, format: "seller_ids_b" });
    expect(config.historyFilter).toEqual({ enabled: false });
    expect(config.filters).toEqual({
      maxReviewCount: 300, minRatingInclusive: 3.5, minPricePence: 699, maxPricePence: 5000,
      maxVariations: 3, maxNewAgeDays: 30, maxAgeDays: 180, newListingDailySalesMinimum: 3,
    });
    expect(config.stores.proxyControllerPath).toContain("seller-sprite-poc");
  });

  it("rejects history filtering and superseded source formats", () => {
    const fixture = fixtureConfig();
    const history = path.join(fixture.root, "history.yaml");
    const oldFormat = path.join(fixture.root, "old-format.yaml");
    writeFileSync(history, fixture.text.replace("enabled: false", "enabled: true"));
    writeFileSync(oldFormat, fixture.text.replace("seller_ids_b", "seller_links_de"));
    expect(() => loadConfig(history)).toThrow(/historyFilter\.enabled.*false/);
    expect(() => loadConfig(oldFormat)).toThrow(/source\.format.*seller_ids_b/);
  });
});
