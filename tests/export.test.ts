import { existsSync } from "node:fs";
import path from "node:path";
import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { EXPORT_HEADERS, writeExcelExport } from "../../src/export/excel.js";
import { runFixture, seedCandidates } from "./helpers.js";

const AS_OF_DATE = "2026-08-13";

function dateForAge(age: number): string {
  return new Date(Date.UTC(2026, 7, 13 - age)).toISOString().slice(0, 10);
}

function sheetAsins(sheet: ExcelJS.Worksheet): string[] {
  const asins: string[] = [];
  for (let rowNumber = 2; rowNumber <= sheet.actualRowCount; rowNumber += 1) {
    const value = sheet.getCell(rowNumber, 3).value as ExcelJS.CellHyperlinkValue;
    asins.push(value.text);
  }
  return asins;
}

describe("19-column, five-sheet export", () => {
  it("writes typed values and hyperlinks using one atomic target", async () => {
    const { store } = runFixture();
    const [asin] = seedCandidates(store, 1);
    const occurrenceId = (store.db.prepare("SELECT occurrence_id FROM asin_candidates WHERE asin=?").get(asin) as { occurrence_id: number }).occurrence_id;
    store.db.prepare("UPDATE asin_candidates SET state='retained' WHERE asin=?").run(asin);
    store.db.prepare(`INSERT INTO cleaned_products(asin,seller_id,occurrence_id,site,image_url,product_url,store_name,store_url,child_sales_30d,daily_sales_3_plus,unit_price_pence,date_first_available,review_count,rating,fulfillment,variation_count,title,category,features_json,overviews,brand,brand_url,created_at,updated_at) VALUES(?,'A123456789',?,'amazon.co.uk','https://example.invalid/mcp.jpg',?,'First','https://amazon.co.uk/s?me=A123456789',100,'yes',699,'2026-08-01',300,3.6,'FBA',5,'Example title','Home & Kitchen',?,?,?,?,'x','x')`).run(asin, occurrenceId, `https://www.amazon.co.uk/dp/${asin}`, JSON.stringify(["First point", "Second point"]), '{"Brand":"Example"}', "Example Brand", "https://www.amazon.co.uk/example-brand");
    store.setStage("sales_7d", "completed");
    store.setStage("detail", "completed");
    const exportedAt = new Date("2026-08-17T06:05:59.000Z");
    const target = await writeExcelExport(store, exportedAt);
    expect(await writeExcelExport(store, exportedAt)).toBe(target);
    expect(path.basename(target)).toBe("英国通过店铺去爬取ASIN-产品数据-20260817-1405.xlsx");
    expect(existsSync(target)).toBe(true);
    const book = new ExcelJS.Workbook();
    await book.xlsx.readFile(target);
    expect(book.worksheets.map((item) => item.name)).toEqual(["0-30天", "31-365天", "366-550天", "551-720天", "产品数据"]);
    const sheet = book.getWorksheet("产品数据")!;
    const newProductsSheet = book.getWorksheet("0-30天")!;
    expect(sheet.getRow(1).values).toEqual([, ...EXPORT_HEADERS]);
    expect(newProductsSheet.getRow(1).values).toEqual([, ...EXPORT_HEADERS]);
    expect(sheetAsins(newProductsSheet)).toEqual([asin]);
    expect(sheet.getCell("C2").value).toMatchObject({ text: asin, hyperlink: `https://www.amazon.co.uk/dp/${asin}` });
    expect(sheet.getCell("F2").value).toBe(100);
    expect(sheet.getCell("G2").value).toBe("yes");
    expect(sheet.getCell("H2").value).toBe(6.99);
    expect(sheet.getCell("I2").value).toBeInstanceOf(Date);
    expect(sheet.getCell("M2").value).toBe(5);
    expect(sheet.getCell("N2").value).toBe("Example title");
    expect(sheet.getCell("O2").value).toBe("Home & Kitchen");
    expect(sheet.getCell("P2").value).toBe("First point\nSecond point");
    expect(sheet.getCell("Q2").value).toBe('{"Brand":"Example"}');
    expect(sheet.getCell("R2").value).toBe("Example Brand");
    expect(sheet.getCell("S2").value).toMatchObject({ text: "https://www.amazon.co.uk/example-brand", hyperlink: "https://www.amazon.co.uk/example-brand" });
    expect(sheet.getCell("P2").alignment).toMatchObject({ vertical: "top", wrapText: true });
    expect(sheet.autoFilter).toBe("A1:S2");
    expect(newProductsSheet.autoFilter).toBe("A1:S2");
    for (const emptySheetName of ["31-365天", "366-550天", "551-720天"]) {
      const emptySheet = book.getWorksheet(emptySheetName)!;
      expect(emptySheet.actualRowCount).toBe(1);
      expect(emptySheet.getRow(1).values).toEqual([, ...EXPORT_HEADERS]);
      expect(emptySheet.autoFilter).toBe("A1:S1");
    }
    store.close();
  });

  it("places inclusive age boundaries into four non-overlapping sheets and keeps the total sheet complete", async () => {
    const { store } = runFixture();
    const asins = seedCandidates(store, 8);
    const ages = [0, 30, 31, 365, 366, 550, 551, 720];
    const insert = store.db.prepare(`INSERT INTO cleaned_products(asin,seller_id,occurrence_id,site,product_url,store_name,store_url,unit_price_pence,date_first_available,review_count,rating,fulfillment,variation_count,title,category,created_at,updated_at)
      VALUES(?,'A123456789',?,'amazon.co.uk',?,'First','https://amazon.co.uk/s?me=A123456789',699,?,300,3.6,'FBA',3,?,'Home','x','x')`);
    ages.forEach((age, index) => {
      const asin = asins[index]!;
      const occurrenceId = (store.db.prepare("SELECT occurrence_id FROM asin_candidates WHERE asin=?").get(asin) as { occurrence_id: number }).occurrence_id;
      store.db.prepare("UPDATE asin_candidates SET state='retained' WHERE asin=?").run(asin);
      insert.run(asin, occurrenceId, `https://www.amazon.co.uk/dp/${asin}`, dateForAge(age), `Age ${age}`);
    });
    store.setStage("sales_7d", "completed");
    store.setStage("detail", "completed");

    const target = await writeExcelExport(store, new Date(`${AS_OF_DATE}T08:00:00.000Z`));
    const book = new ExcelJS.Workbook();
    await book.xlsx.readFile(target);

    expect(sheetAsins(book.getWorksheet("0-30天")!)).toEqual(asins.slice(0, 2));
    expect(sheetAsins(book.getWorksheet("31-365天")!)).toEqual(asins.slice(2, 4));
    expect(sheetAsins(book.getWorksheet("366-550天")!)).toEqual(asins.slice(4, 6));
    expect(sheetAsins(book.getWorksheet("551-720天")!)).toEqual(asins.slice(6, 8));
    expect(sheetAsins(book.getWorksheet("产品数据")!)).toEqual(asins);
    store.close();
  });

  it("fails explicitly instead of truncating an oversized new field", async () => {
    const { store } = runFixture();
    const [asin] = seedCandidates(store, 1);
    const occurrenceId = (store.db.prepare("SELECT occurrence_id FROM asin_candidates WHERE asin=?").get(asin) as { occurrence_id: number }).occurrence_id;
    store.db.prepare("UPDATE asin_candidates SET state='retained' WHERE asin=?").run(asin);
    store.db.prepare(`INSERT INTO cleaned_products(asin,seller_id,occurrence_id,site,product_url,store_name,store_url,unit_price_pence,date_first_available,review_count,rating,fulfillment,variation_count,title,category,created_at,updated_at)
      VALUES(?,'A123456789',?,'amazon.co.uk',?,'First','https://amazon.co.uk/s?me=A123456789',699,'2026-08-01',300,3.6,'FBA',5,?,'Home','x','x')`)
      .run(asin, occurrenceId, `https://www.amazon.co.uk/dp/${asin}`, "x".repeat(32_768));
    store.setStage("sales_7d", "completed");
    store.setStage("detail", "completed");
    await expect(writeExcelExport(store)).rejects.toThrow(`asin=${asin}, column=标题`);
    expect(store.exports.rows()[0]?.title).toHaveLength(32_768);
    store.close();
  });
});
