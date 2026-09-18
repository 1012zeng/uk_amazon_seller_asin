import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import ExcelJS from "exceljs";
import type { SourceStoreResult, StoreSeed } from "../shared/types.js";
import { detectSellerWorkbookLayout, readSellerWorkbookRow } from "./seller-workbook-adapter.js";

export function extractSellerId(profileUrl: string): string | null {
  try {
    const url = new URL(profileUrl);
    const hostname = url.hostname.toLowerCase();
    if (hostname !== "amazon.co.uk" && !hostname.endsWith(".amazon.co.uk")) return null;
    const sellerId = (url.searchParams.get("seller") ?? url.searchParams.get("me") ?? "").trim().toUpperCase();
    return /^[A-Z0-9]{10,20}$/.test(sellerId) ? sellerId : null;
  } catch {
    return null;
  }
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
