import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { readStoreSeeds } from "../../src/input/source-stores.js";

interface WorkbookLayout {
  sheetName?: string;
  nameColumn?: number;
  linkColumn?: number;
  nameHeader?: string;
  linkHeader?: string;
}

async function workbook(rows: Array<[ExcelJS.CellValue, ExcelJS.CellValue]>, layout: WorkbookLayout = {}): Promise<string> {
  const target = path.join(mkdtempSync(path.join(os.tmpdir(), "stores-xlsx-")), "source.xlsx");
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet(layout.sheetName ?? "产品数据");
  const nameColumn = layout.nameColumn ?? 4;
  const linkColumn = layout.linkColumn ?? 5;
  sheet.getCell(1, nameColumn).value = layout.nameHeader ?? "店铺";
  sheet.getCell(1, linkColumn).value = layout.linkHeader ?? "卖家链接";
  rows.forEach(([name, link], index) => {
    sheet.getCell(index + 2, nameColumn).value = name;
    sheet.getCell(index + 2, linkColumn).value = link;
  });
  await book.xlsx.writeFile(target);
  return target;
}

describe("Excel seller import", () => {
  it("reads hyperlinks and keeps earliest source row per Seller ID", async () => {
    const file = await workbook([
      [{ text: "Alpha", hyperlink: "https://example.invalid" }, "https://www.amazon.co.uk/sp?seller=A123456789"],
      ["Alpha", "https://www.amazon.co.uk/sp?seller=B123456789"],
      ["Renamed", { text: "link", hyperlink: "https://www.amazon.co.uk/sp?seller=A123456789" }],
      [{ text: "Alpha", hyperlink: "https://example.invalid" }, "https://www.amazon.co.uk/sp?seller=A123456789"],
    ]);
    const result = await readStoreSeeds(file, "产品数据", "https://www.amazon.co.uk", "A1F83G8C2ARO7P", 0);
    expect(result.seeds.map((seed) => [seed.sellerId, seed.sourceName, seed.sourceRow])).toEqual([
      ["A123456789", "Alpha", 2], ["B123456789", "Alpha", 3],
    ]);
    expect(result.stats).toMatchObject({ sourceRows: 4, duplicateRows: 1, duplicateSellerIds: 1, uniqueStores: 2 });
    expect(result.sourceHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("locates seller homepage columns by semantic headers and records the detected layout", async () => {
    const file = await workbook([
      ["Store A", "https://www.amazon.co.uk/gp/help/seller/at-a-glance.html?seller=A123456789"],
      ["Store B", "https://www.amazon.co.uk/sp?me=B123456789"],
    ], {
      sheetName: "uk_overall_source_data_table",
      nameColumn: 42,
      linkColumn: 45,
      nameHeader: "BuyBox卖家",
      linkHeader: "卖家首页",
    });

    const result = await readStoreSeeds(file, "uk_overall_source_data_table", "https://www.amazon.co.uk", "A1F83G8C2ARO7P", 0);

    expect(result.seeds.map((seed) => [seed.sellerId, seed.sourceName, seed.storeUrl])).toEqual([
      ["A123456789", "Store A", "https://www.amazon.co.uk/s?me=A123456789&marketplaceID=A1F83G8C2ARO7P"],
      ["B123456789", "Store B", "https://www.amazon.co.uk/s?me=B123456789&marketplaceID=A1F83G8C2ARO7P"],
    ]);
    expect(result.stats.detectedLayout).toEqual({
      sheet: "uk_overall_source_data_table",
      headerRow: 1,
      sellerName: { header: "BuyBox卖家", column: 42, columnLetter: "AP" },
      sellerProfileUrl: { header: "卖家首页", column: 45, columnLetter: "AS" },
    });
  });

  it("supports the keyword export seller-homepage header without fixed D/E assumptions", async () => {
    const file = await workbook([
      ["Keyword Store", "https://www.amazon.co.uk/sp?seller=A123456789"],
    ], { nameColumn: 7, linkColumn: 2, linkHeader: "卖家首页" });

    const result = await readStoreSeeds(file, "产品数据", "https://www.amazon.co.uk", "A1F83G8C2ARO7P", 0);

    expect(result.seeds[0]).toMatchObject({ sellerId: "A123456789", sourceName: "Keyword Store", sourceRow: 2 });
    expect(result.stats.detectedLayout).toMatchObject({
      sellerName: { header: "店铺", column: 7, columnLetter: "G" },
      sellerProfileUrl: { header: "卖家首页", column: 2, columnLetter: "B" },
    });
  });

  it("uses the first Seller IDs for a limited real canary", async () => {
    const file = await workbook([["A", "https://amazon.co.uk/sp?seller=A123456789"], ["B", "https://amazon.co.uk/sp?seller=B123456789"], ["C", "https://amazon.co.uk/sp?seller=C123456789"]]);
    const result = await readStoreSeeds(file, "产品数据", "https://www.amazon.co.uk", "A1F83G8C2ARO7P", 2);
    expect(result.seeds.map((seed) => seed.sellerId)).toEqual(["A123456789", "B123456789"]);
  });

  it("reports formulas, rich text, blanks and invalid Seller IDs by row", async () => {
    const file = await workbook([
      [{ formula: "=\"Name\"", result: "Name" }, "https://amazon.co.uk/sp?seller=A123456789"],
      [{ richText: [{ text: "Rich" }] }, "https://amazon.co.uk/sp?seller=B123456789"],
      ["Valid", "not-a-url"],
      ["   ", "https://amazon.co.uk/sp?seller=C123456789"],
    ]);
    await expect(readStoreSeeds(file, "产品数据", "https://www.amazon.co.uk", "A1F83G8C2ARO7P", 0)).rejects.toThrow(/第 2 行.*第 3 行.*第 4 行.*第 5 行/s);
  });

  it("rejects a valid-looking Seller ID on a non-Amazon host", async () => {
    const file = await workbook([["Invalid", "https://example.invalid/sp?seller=A123456789"]]);
    await expect(readStoreSeeds(file, "产品数据", "https://www.amazon.co.uk", "A1F83G8C2ARO7P", 0)).rejects.toThrow(/第 2 行.*Seller ID/s);
  });

  it("rejects missing or ambiguous semantic headers before reading rows", async () => {
    const missing = await workbook([["Store", "https://amazon.co.uk/sp?seller=A123456789"]], { linkHeader: "品牌链接" });
    await expect(readStoreSeeds(missing, "产品数据", "https://www.amazon.co.uk", "A1F83G8C2ARO7P", 0)).rejects.toThrow(/卖家首页.*卖家链接/s);

    const duplicate = await workbook([["Store", "https://amazon.co.uk/sp?seller=A123456789"]], { linkHeader: "卖家首页" });
    const book = new ExcelJS.Workbook();
    await book.xlsx.readFile(duplicate);
    book.getWorksheet("产品数据")!.getCell("H1").value = "卖家链接";
    await book.xlsx.writeFile(duplicate);
    await expect(readStoreSeeds(duplicate, "产品数据", "https://www.amazon.co.uk", "A1F83G8C2ARO7P", 0)).rejects.toThrow(/多个.*卖家.*链接.*E.*H/s);
  });
});
