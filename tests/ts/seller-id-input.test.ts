import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { readSellerIdsColumnB } from "../../src/input/source-stores.js";

async function workbookFile(rows: Array<ExcelJS.CellValue>): Promise<string> {
  const root = mkdtempSync(path.join(os.tmpdir(), "seller-id-input-"));
  const target = path.join(root, "source.xlsx");
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet("卖家数据");
  sheet.getCell("B1").value = "卖家名称";
  rows.forEach((value, index) => { sheet.getCell(`B${index + 2}`).value = value; });
  await book.xlsx.writeFile(target);
  return target;
}

describe("B-column seller ID input", () => {
  it("reads hyperlink IDs, direct IDs, names, and first-seen order", async () => {
    const file = await workbookFile([
      { text: "Seller A", hyperlink: "https://www.amazon.co.uk/s?me=A2T5LHS3VM5VWI" },
      { text: "Duplicate", hyperlink: "https://www.amazon.co.uk/s?me=A2T5LHS3VM5VWI" },
      "A2JJMZA6BSQ5HS",
      "",
    ]);
    const result = await readSellerIdsColumnB(file, "卖家数据", "https://www.amazon.co.uk", "A1F83G8C2ARO7P", 0);
    expect(result.seeds.map((seed) => [seed.sellerId, seed.sourceName, seed.sourceRow])).toEqual([
      ["A2T5LHS3VM5VWI", "Seller A", 2],
      ["A2JJMZA6BSQ5HS", "A2JJMZA6BSQ5HS", 4],
    ]);
    expect(result.stats).toMatchObject({ sourceRows: 4, duplicateSellerIds: 1, uniqueStores: 2, inputKind: "seller_ids_b" });
  });

  it("reports the source row for an invalid non-empty B cell", async () => {
    const file = await workbookFile([{ text: "Not a seller", hyperlink: "https://example.com/store" }]);
    await expect(readSellerIdsColumnB(file, "卖家数据", "https://www.amazon.co.uk", "A1F83G8C2ARO7P", 0)).rejects.toThrow(/第 2 行 B 列/);
  });

  it("does not treat a row with another populated cell as a blank row", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "seller-id-input-row-"));
    const target = path.join(root, "source.xlsx");
    const book = new ExcelJS.Workbook();
    const sheet = book.addWorksheet("卖家数据");
    sheet.getCell("B1").value = "卖家名称";
    sheet.getCell("A2").value = "说明";
    await book.xlsx.writeFile(target);
    await expect(readSellerIdsColumnB(target, "卖家数据", "https://www.amazon.co.uk", "A1F83G8C2ARO7P", 0)).rejects.toThrow(/第 2 行 B 列/);
  });

  it("rejects non-HTTP(S) and preserves the first source row", async () => {
    const file = await workbookFile([
      { text: "Seller A", hyperlink: "ftp://www.amazon.co.uk/s?me=A2T5LHS3VM5VWI" },
      "A2T5LHS3VM5VWI",
    ]);
    await expect(readSellerIdsColumnB(file, "卖家数据", "https://www.amazon.co.uk", "A1F83G8C2ARO7P", 0)).rejects.toThrow(/第 2 行 B 列/);
  });
});
