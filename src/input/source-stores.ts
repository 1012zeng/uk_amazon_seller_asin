import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import ExcelJS from "exceljs";
import type { SellerIdsColumnBLayout, SourceStoreResult, StoreSeed } from "../shared/types.js";
import { detectSellerWorkbookLayout, readSellerWorkbookRow } from "./seller-workbook-adapter.js";

export function extractSellerId(profileUrl: string): string | null {
  try {
    const url = new URL(profileUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    const hostname = url.hostname.toLowerCase();
    if (hostname !== "amazon.co.uk" && !hostname.endsWith(".amazon.co.uk")) return null;
    const sellerId = (url.searchParams.get("seller") ?? url.searchParams.get("me") ?? "").trim().toUpperCase();
    return /^[A-Z0-9]{10,20}$/.test(sellerId) ? sellerId : null;
  } catch {
    return null;
  }
}

function sellerIdFromCellValue(value: ExcelJS.CellValue): { sellerId: string | null; displayName: string; sourceUrl: string } {
  if (value === null || value === undefined || value === "") return { sellerId: null, displayName: "", sourceUrl: "" };
  if (typeof value === "object" && "formula" in value) throw new Error("B 列不允许公式");
  if (typeof value === "object" && "richText" in value) throw new Error("B 列不允许富文本");
  if (typeof value === "object" && "hyperlink" in value) {
    const hyperlink = value as ExcelJS.CellHyperlinkValue;
    const sourceUrl = String(hyperlink.hyperlink ?? "").trim();
    const displayName = String(hyperlink.text ?? "").trim();
    return { sellerId: extractSellerId(sourceUrl), displayName, sourceUrl };
  }
  if (typeof value !== "string") throw new Error("B 列必须是 Seller ID 或 Amazon UK 卖家链接");
  const text = value.trim();
  const sellerId = /^[A-Z0-9]{10,20}$/i.test(text) ? text.toUpperCase() : extractSellerId(text);
  return { sellerId, displayName: sellerId ?? "", sourceUrl: sellerId && /^https?:\/\//i.test(text) ? text : "" };
}

function rowIsCompletelyBlank(row: ExcelJS.Row): boolean {
  const values = Array.isArray(row.values) ? row.values : Object.values(row.values as Record<string, unknown>);
  return values.every((value: unknown) => value === null || value === undefined || value === "" || (typeof value === "string" && value.trim() === ""));
}

export async function readSellerIdsColumnB(
  xlsxPath: string,
  sheetName: string,
  marketplace: string,
  marketplaceId: string,
  limit: number,
): Promise<SourceStoreResult> {
  const sourceHash = createHash("sha256").update(readFileSync(xlsxPath)).digest("hex");
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(xlsxPath);
  const sheet = workbook.getWorksheet(sheetName);
  if (!sheet) throw new Error(`源 Excel 不存在工作表“${sheetName}”`);
  const bySellerId = new Map<string, StoreSeed>();
  const errors: string[] = [];
  let sourceRows = 0;
  let duplicateSellerIds = 0;
  for (let row = 2; row <= sheet.rowCount; row += 1) {
    sourceRows += 1;
    const cell = sheet.getCell(row, 2);
    if (rowIsCompletelyBlank(sheet.getRow(row))) continue;
    try {
      const parsed = sellerIdFromCellValue(cell.value);
      if (!parsed.sellerId) throw new Error(`第 ${row} 行 B 列无法提取合法 Seller ID`);
      const sellerId = parsed.sellerId;
      if (bySellerId.has(sellerId)) {
        duplicateSellerIds += 1;
        continue;
      }
      const profileUrl = parsed.sourceUrl && extractSellerId(parsed.sourceUrl)
        ? parsed.sourceUrl
        : canonicalStoreUrl(marketplace, marketplaceId, sellerId);
      bySellerId.set(sellerId, {
        sellerId,
        sourceRow: row,
        sourceName: parsed.displayName || sellerId,
        sourceProfileUrl: profileUrl,
        storeUrl: canonicalStoreUrl(marketplace, marketplaceId, sellerId),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(message.startsWith("第 ") ? message : `第 ${row} 行：${message}`);
    }
  }
  if (errors.length > 0) throw new Error(`源 Excel 校验失败：\n${errors.join("\n")}`);
  const allSeeds = [...bySellerId.values()].sort((a, b) => a.sourceRow - b.sourceRow);
  if (allSeeds.length === 0) throw new Error("源 Excel B 列没有有效 Seller ID");
  const seeds = limit > 0 ? allSeeds.slice(0, limit) : allSeeds;
  const sellerIdsColumnB: SellerIdsColumnBLayout = { sheet: sheet.name, headerRow: 1, sellerIdColumn: "B" };
  return {
    seeds,
    sourceHash,
    stats: {
      sourceRows,
      duplicateRows: 0,
      duplicateSellerIds,
      uniqueStores: seeds.length,
      appliedLimit: limit,
      inputKind: "seller_ids_b",
      sellerIdsColumnB,
    },
  };
}

export function canonicalStoreUrl(marketplace: string, marketplaceId: string, sellerId: string): string {
  const url = new URL("/s", marketplace);
  url.searchParams.set("me", sellerId);
  url.searchParams.set("marketplaceID", marketplaceId);
  return url.toString();
}

export async function readStoreSeeds(
  xlsxPath: string,
  sheetName: string,
  marketplace: string,
  marketplaceId: string,
  limit: number,
): Promise<SourceStoreResult> {
  const sourceHash = createHash("sha256").update(readFileSync(xlsxPath)).digest("hex");
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(xlsxPath);
  const sheet = workbook.getWorksheet(sheetName);
  if (!sheet) throw new Error(`源 Excel 不存在工作表“${sheetName}”`);
  const detectedLayout = detectSellerWorkbookLayout(sheet);

  const exact = new Set<string>();
  const bySellerId = new Map<string, StoreSeed>();
  let sourceRows = 0;
  let duplicateRows = 0;
  let duplicateSellerIds = 0;
  const errors: string[] = [];
  for (let row = 2; row <= sheet.actualRowCount; row += 1) {
    sourceRows += 1;
    try {
      const { name, profileUrl: link } = readSellerWorkbookRow(sheet, detectedLayout, row);
      const exactKey = `${name}\u0000${link}`;
      if (exact.has(exactKey)) {
        duplicateRows += 1;
        continue;
      }
      exact.add(exactKey);
      const sellerId = extractSellerId(link);
      if (!sellerId) throw new Error(`第 ${row} 行 ${detectedLayout.sellerProfileUrl.columnLetter} 列“${detectedLayout.sellerProfileUrl.header}”无法提取合法 Seller ID`);
      if (bySellerId.has(sellerId)) {
        duplicateSellerIds += 1;
        continue;
      }
      bySellerId.set(sellerId, {
        sellerId,
        sourceRow: row,
        sourceName: name,
        sourceProfileUrl: link,
        storeUrl: canonicalStoreUrl(marketplace, marketplaceId, sellerId),
      });
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (errors.length > 0) throw new Error(`源 Excel 校验失败：\n${errors.join("\n")}`);
  const allSeeds = [...bySellerId.values()].sort((a, b) => a.sourceRow - b.sourceRow);
  if (allSeeds.length === 0) throw new Error("源 Excel 没有有效卖家");
  const seeds = limit > 0 ? allSeeds.slice(0, limit) : allSeeds;
  return {
    seeds,
    sourceHash,
    stats: { sourceRows, duplicateRows, duplicateSellerIds, uniqueStores: seeds.length, appliedLimit: limit, inputKind: "seller_links_de", detectedLayout },
  };
}
