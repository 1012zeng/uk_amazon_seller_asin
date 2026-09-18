import { mkdirSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import ExcelJS from "exceljs";
import type { RunStore } from "../database/run-store.js";
import { listingAgeBands, listingAgeDays, type ListingAgeBand } from "../shared/listing-age.js";
import type { ExportRow } from "../shared/types.js";

export const EXPORT_HEADERS = ["站点", "图片", "ASIN(超链)", "店铺", "卖家首页", "子体销量", "是否达到新品日销量门槛", "销售单价（GBP）", "上架时间", "评论数量", "评分", "配送方式", "变体数", "标题", "类目", "五点", "详情", "品牌", "品牌链接"] as const;
const MAX_DATA_ROWS = 1_048_575;
const MAX_CELL_TEXT_LENGTH = 32_767;
const COLUMN_WIDTHS = [16, 42, 18, 26, 48, 14, 18, 18, 16, 14, 10, 14, 12, 52, 36, 64, 64, 28, 52];
const BEIJING_TIME_FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

function beijingMinuteTimestamp(date: Date): string {
  const parts = Object.fromEntries(BEIJING_TIME_FORMATTER.formatToParts(date).map(({ type, value }) => [type, value]));
  return `${parts.year}${parts.month}${parts.day}-${parts.hour}${parts.minute}`;
}

function hyperlink(text: string, target: string): ExcelJS.CellHyperlinkValue | string {
  return target ? { text, hyperlink: target } : text;
}

function checkedText(value: string, asin: string, label: string): string {
  if (value.length > MAX_CELL_TEXT_LENGTH) throw new Error(`Excel cell text exceeds 32767 characters: asin=${asin}, column=${label}`);
  return value;
}

function featureText(value: string | null, asin: string): string {
  if (value === null) return "";
  let parsed: unknown;
  try { parsed = JSON.parse(value); }
  catch { throw new Error(`Invalid features_json for ASIN ${asin}`); }
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) throw new Error(`Invalid features_json for ASIN ${asin}`);
  return checkedText(parsed.join("\n"), asin, "五点");
}

function rowsByAgeBand(rows: ExportRow[], bands: ListingAgeBand[], asOfDate: string): Array<{ band: ListingAgeBand; rows: ExportRow[] }> {
  const grouped = bands.map((band) => ({ band, rows: [] as ExportRow[] }));
  for (const row of rows) {
    const age = listingAgeDays(row.date_first_available, asOfDate);
    const target = age === null ? undefined : grouped.find(({ band }) => age >= band.minimumAgeDays && age <= band.maximumAgeDays);
    if (!target) throw new Error(`Export row has an invalid or out-of-range listing age: asin=${row.asin}, date=${row.date_first_available}, as_of_date=${asOfDate}`);
    target.rows.push(row);
  }
  return grouped;
}

function writeWorksheet(workbook: ExcelJS.stream.xlsx.WorkbookWriter, name: string, rows: ExportRow[], marketplace: string): void {
  const sheet = workbook.addWorksheet(name, { views: [{ state: "frozen", ySplit: 1, showGridLines: false }] });
  sheet.columns = COLUMN_WIDTHS.map((width) => ({ width }));
  const header = sheet.addRow([...EXPORT_HEADERS]);
  header.height = 24;
  header.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F4E78" } };
    cell.alignment = { horizontal: "center", vertical: "middle" };
  });
  header.commit();
  for (const row of rows) {
    const output = sheet.addRow([
      hyperlink(row.site, marketplace), hyperlink(row.image_url, row.image_url), hyperlink(row.asin, row.product_url), row.store_name,
      hyperlink(row.store_url, row.store_url), row.child_sales_30d ?? "", row.daily_sales_3_plus ?? "", row.unit_price_pence / 100,
      new Date(`${row.date_first_available}T00:00:00.000Z`), row.review_count ?? "NA", row.rating ?? "NA", row.fulfillment, row.variation_count,
      checkedText(row.title, row.asin, "标题"), checkedText(row.category, row.asin, "类目"), featureText(row.features_json, row.asin),
      checkedText(row.overviews ?? "", row.asin, "详情"),
      checkedText(row.brand, row.asin, "品牌"), hyperlink(checkedText(row.brand_url, row.asin, "品牌链接"), row.brand_url),
    ]);
    output.getCell(6).numFmt = "#,##0";
    output.getCell(8).numFmt = "£0.00";
    output.getCell(9).numFmt = "yyyy-mm-dd";
    output.getCell(10).numFmt = "#,##0";
    output.getCell(11).numFmt = "0.0";
    output.getCell(13).numFmt = "#,##0";
    output.eachCell((cell) => { cell.alignment = { vertical: "top" }; });
    for (let column = 14; column <= 19; column += 1) output.getCell(column).alignment = { vertical: "top", wrapText: true };
    output.commit();
  }
  sheet.autoFilter = { from: "A1", to: `S${rows.length + 1}` };
  sheet.commit();
}

export async function writeExcelExport(store: RunStore, exportedAt = new Date()): Promise<string> {
  if (store.source.stageStatus("detail") !== "completed") throw new Error("Export requires completed ASIN detail stage");
  if (!store.enrichments.isTerminal() || !store.sales.isTerminal() || !store.details.isTerminal()) throw new Error("Export refused because downstream tasks are not terminal");
  const rows = store.exports.rows();
  if (rows.length > MAX_DATA_ROWS) throw new Error(`Excel row limit exceeded: ${rows.length} > ${MAX_DATA_ROWS}`);
  const config = store.getRunConfig();
  const exportDir = path.join(store.runDir, "exports");
  mkdirSync(exportDir, { recursive: true });
  const target = path.join(exportDir, `英国通过店铺去爬取ASIN-产品数据-${beijingMinuteTimestamp(exportedAt)}.xlsx`);
  const temporary = path.join(exportDir, `.export.${process.pid}.${Date.now()}.tmp.xlsx`);
  rmSync(temporary, { force: true });
  try {
    const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({ filename: temporary, useStyles: true, useSharedStrings: false });
    const ageBands = listingAgeBands(config.filters);
    for (const { band, rows: bandRows } of rowsByAgeBand(rows, ageBands, store.getAsOfDate())) {
      writeWorksheet(workbook, band.sheetName, bandRows, config.amazon.marketplace);
    }
    writeWorksheet(workbook, "产品数据", rows, config.amazon.marketplace);
    await workbook.commit();
    renameSync(temporary, target);
    return target;
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}
