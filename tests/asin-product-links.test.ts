import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { parseAmazonUkProductLink, readAsinProductLinks } from "../../src/input/asin-product-links.js";

async function workbook(rows: Array<[ExcelJS.CellValue, ExcelJS.CellValue]>): Promise<string> {
  const target = path.join(mkdtempSync(path.join(os.tmpdir(), "asin-links-xlsx-")), "source.xlsx");
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet("Sheet1");
  sheet.getCell("A1").value = "站点";
  sheet.getCell("B1").value = "ASIN竞品链接";
  rows.forEach(([site, link], index) => {
    sheet.getCell(index + 2, 1).value = site;
    sheet.getCell(index + 2, 2).value = link;
  });
  await book.xlsx.writeFile(target);
  return target;
}

describe("ASIN product-link Excel import", () => {
  it("reads B links, repairs spaces after /dp/, and keeps the earliest row per ASIN", async () => {
    const file = await workbook([
      ["UK", "https://www.amazon.co.uk/dp/B012345678"],
      ["UK", "https://www.amazon.co.uk/dp/  B087654321"],
      ["UK", { text: "product", hyperlink: "https://amazon.co.uk/gp/product/B012345678?ref=test" }],
    ]);
    const result = await readAsinProductLinks(file, "Sheet1", "https://www.amazon.co.uk", 0);
    expect(result.products).toEqual([
      { asin: "B012345678", sourceRow: 2, productUrl: "https://www.amazon.co.uk/dp/B012345678" },
      { asin: "B087654321", sourceRow: 3, productUrl: "https://www.amazon.co.uk/dp/B087654321" },
    ]);
    expect(result.stats).toMatchObject({ sourceRows: 3, duplicateAsins: 1, uniqueProductAsins: 2, inputKind: "asin_links_b" });
  });

  it("applies the limit after validation and ASIN deduplication", async () => {
    const file = await workbook([
      ["UK", "https://amazon.co.uk/dp/B012345678"],
      ["UK", "https://amazon.co.uk/dp/B087654321"],
    ]);
    const result = await readAsinProductLinks(file, "Sheet1", "https://www.amazon.co.uk", 1);
    expect(result.products.map((item) => item.asin)).toEqual(["B012345678"]);
  });

  it("rejects non-UK rows and non-Amazon product links with row evidence", async () => {
    const file = await workbook([
      ["DE", "https://amazon.co.uk/dp/B012345678"],
      ["UK", "https://example.invalid/dp/B087654321"],
    ]);
    await expect(readAsinProductLinks(file, "Sheet1", "https://www.amazon.co.uk", 0)).rejects.toThrow(/第 2 行.*第 3 行/s);
  });

  it("normalizes only supported Amazon UK product paths", () => {
    expect(parseAmazonUkProductLink("https://www.amazon.co.uk/dp/ B012345678", "https://www.amazon.co.uk")).toEqual({ asin: "B012345678", productUrl: "https://www.amazon.co.uk/dp/B012345678" });
    expect(parseAmazonUkProductLink("https://www.amazon.com/dp/B012345678", "https://www.amazon.co.uk")).toBeNull();
    expect(parseAmazonUkProductLink("https://www.amazon.co.uk/sp?seller=A123456789", "https://www.amazon.co.uk")).toBeNull();
  });
});
