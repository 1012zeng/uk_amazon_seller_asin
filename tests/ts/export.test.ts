import { existsSync } from "node:fs";
import path from "node:path";
import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { EXPORT_HEADERS, writeExcelExport } from "../../src/export/excel.js";
import { runFixture, seedCandidates } from "./helpers.js";

const AS_OF_DATE = "2026-08-13";
function dateForAge(age: number): string { return new Date(Date.UTC(2026, 7, 13 - age)).toISOString().slice(0, 10); }
function sheetAsins(sheet: ExcelJS.Worksheet): string[] {
  return Array.from({ length: Math.max(0, sheet.actualRowCount - 1) }, (_, index) => (sheet.getCell(index + 2, 3).value as ExcelJS.CellHyperlinkValue).text);
}
function addProduct(store: ReturnType<typeof runFixture>["store"], asin: string, age: number, reviewCount: number | null, rating: number | null): void {
  const occurrenceId = (store.db.prepare("SELECT occurrence_id FROM asin_candidates WHERE asin=?").get(asin) as { occurrence_id: number }).occurrence_id;
  store.db.prepare("UPDATE asin_candidates SET state='retained' WHERE asin=?").run(asin);
  store.db.prepare(`INSERT INTO cleaned_products(asin,seller_id,occurrence_id,site,product_url,store_name,store_url,unit_price_pence,date_first_available,review_count,rating,fulfillment,variation_count,title,category,brand,brand_url,created_at,updated_at)
    VALUES(?,'A123456789',?,'amazon.co.uk',?,'First','https://amazon.co.uk/s?me=A123456789',699,?,?,?,?,3,'Example','Home','Brand','https://example.invalid/brand','x','x')`)
    .run(asin, occurrenceId, `https://www.amazon.co.uk/dp/${asin}`, dateForAge(age), reviewCount, rating, "FBA");
}

describe("three-sheet export", () => {
  it("writes 0-30, 31-180, and complete sheets with NA display values", async () => {
    const { store } = runFixture();
    const asins = seedCandidates(store, 3);
    addProduct(store, asins[0]!, 0, null, null);
    addProduct(store, asins[1]!, 30, 300, 3.5);
    addProduct(store, asins[2]!, 180, null, 4);
    store.setStage("sales_7d", "completed");
    store.setStage("detail", "completed");
    const target = await writeExcelExport(store, new Date("2026-08-17T06:05:59.000Z"));
    expect(path.basename(target)).toBe("英国通过店铺去爬取ASIN-产品数据-20260817-1405.xlsx");
    expect(existsSync(target)).toBe(true);
    const book = new ExcelJS.Workbook();
    await book.xlsx.readFile(target);
    expect(book.worksheets.map((item) => item.name)).toEqual(["0-30天", "31-180天", "产品数据"]);
    expect(book.getWorksheet("产品数据")!.getRow(1).values).toEqual([, ...EXPORT_HEADERS]);
    expect(sheetAsins(book.getWorksheet("0-30天")!)).toEqual(asins.slice(0, 2));
    expect(sheetAsins(book.getWorksheet("31-180天")!)).toEqual([asins[2]]);
    expect(sheetAsins(book.getWorksheet("产品数据")!)).toEqual(asins);
    expect(book.getWorksheet("产品数据")!.getCell("J2").value).toBe("NA");
    expect(book.getWorksheet("产品数据")!.getCell("K2").value).toBe("NA");
    store.close();
  });

  it("keeps age boundaries inclusive and rejects out-of-range export rows", async () => {
    const { store } = runFixture();
    const asins = seedCandidates(store, 2);
    addProduct(store, asins[0]!, 31, 1, 4);
    addProduct(store, asins[1]!, 180, 1, 4);
    store.setStage("sales_7d", "completed");
    store.setStage("detail", "completed");
    const target = await writeExcelExport(store, new Date("2026-08-13T00:00:00.000Z"));
    const book = new ExcelJS.Workbook();
    await book.xlsx.readFile(target);
    expect(sheetAsins(book.getWorksheet("31-180天")!)).toEqual(asins);
    store.close();
  });

  it("fails explicitly instead of truncating oversized text", async () => {
    const { store } = runFixture();
    const [asin] = seedCandidates(store, 1);
    addProduct(store, asin!, 0, null, null);
    store.db.prepare("UPDATE cleaned_products SET title=? WHERE asin=?").run("x".repeat(32_768), asin);
    store.setStage("sales_7d", "completed");
    store.setStage("detail", "completed");
    await expect(writeExcelExport(store)).rejects.toThrow(`asin=${asin}, column=标题`);
    store.close();
  });
});
