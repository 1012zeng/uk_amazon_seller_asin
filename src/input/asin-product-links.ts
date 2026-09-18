import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import ExcelJS from "exceljs";
import type { SourceProductLink, SourceProductResult } from "../shared/types.js";
import { canonicalProductUrl } from "../amazon/parsing.js";

function normalized(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function cellKind(value: ExcelJS.CellValue): "empty" | "text" | "hyperlink" | "formula" | "rich" | "other" {
  if (value === null || value === undefined || value === "") return "empty";
  if (typeof value === "string") return "text";
  if (typeof value === "object" && "formula" in value) return "formula";
  if (typeof value === "object" && "richText" in value) return "rich";
  if (typeof value === "object" && "hyperlink" in value) return "hyperlink";
  return "other";
}

function cellText(cell: ExcelJS.Cell, row: number, column: "A" | "B", label: string, hyperlinkTarget = false): string {
  const kind = cellKind(cell.value);
  if (kind === "formula" || kind === "rich") throw new Error(`第 ${row} 行 ${column} 列“${label}”不允许公式或富文本`);
  if (kind === "text") return normalized(cell.value as string);
  if (kind === "hyperlink") {
    const value = cell.value as ExcelJS.CellHyperlinkValue;
    return normalized(String(hyperlinkTarget ? value.hyperlink ?? "" : value.text ?? ""));
  }
  if (kind === "empty") throw new Error(`第 ${row} 行 ${column} 列“${label}”为空`);
  throw new Error(`第 ${row} 行 ${column} 列“${label}”数据类型无效`);
}

export function parseAmazonUkProductLink(value: string, marketplace: string): { asin: string; productUrl: string } | null {
  const repaired = value.trim().replace(/(\/(?:dp|gp\/product)\/)\s+([A-Z0-9]{10})(?=[/?#]|$)/i, "$1$2");
  try {
    const url = new URL(repaired);
    const hostname = url.hostname.toLowerCase();
    if (hostname !== "amazon.co.uk" && !hostname.endsWith(".amazon.co.uk")) return null;
    const match = url.pathname.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})(?:[/?]|$)/i);
    if (!match?.[1]) return null;
    const asin = match[1].toUpperCase();
    return { asin, productUrl: canonicalProductUrl(marketplace, asin) };
  } catch {
    return null;
  }
}

export async function readAsinProductLinks(
  xlsxPath: string,
  sheetName: string,
  marketplace: string,
  limit: number,
): Promise<SourceProductResult> {
  const sourceHash = createHash("sha256").update(readFileSync(xlsxPath)).digest("hex");
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(xlsxPath);
  const sheet = workbook.getWorksheet(sheetName);
  if (!sheet) throw new Error(`源 Excel 不存在工作表“${sheetName}”`);
  if (normalized(sheet.getCell("A1").text) !== "站点" || normalized(sheet.getCell("B1").text) !== "ASIN竞品链接") {
    throw new Error("源 Excel 表头不匹配：A1 必须为“站点”，B1 必须为“ASIN竞品链接”");
  }

  const exact = new Set<string>();
  const byAsin = new Map<string, SourceProductLink>();
  let sourceRows = 0;
  let duplicateRows = 0;
  let duplicateAsins = 0;
  const errors: string[] = [];
  for (let row = 2; row <= sheet.actualRowCount; row += 1) {
    sourceRows += 1;
    try {
      const site = cellText(sheet.getCell(row, 1), row, "A", "站点").toUpperCase();
      if (site !== "UK") throw new Error(`第 ${row} 行 A 列“站点”必须为 UK`);
      const link = cellText(sheet.getCell(row, 2), row, "B", "ASIN竞品链接", true);
      const exactKey = `${site}\u0000${link}`;
      if (exact.has(exactKey)) {
        duplicateRows += 1;
        continue;
      }
      exact.add(exactKey);
      const parsed = parseAmazonUkProductLink(link, marketplace);
      if (!parsed) throw new Error(`第 ${row} 行 B 列无法提取合法 Amazon UK ASIN 商品链接`);
      if (byAsin.has(parsed.asin)) {
        duplicateAsins += 1;
        continue;
      }
      byAsin.set(parsed.asin, { asin: parsed.asin, sourceRow: row, productUrl: parsed.productUrl });
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (errors.length > 0) throw new Error(`源 Excel 校验失败：\n${errors.join("\n")}`);
  const allProducts = [...byAsin.values()].sort((left, right) => left.sourceRow - right.sourceRow);
  if (allProducts.length === 0) throw new Error("源 Excel 没有有效 ASIN 商品链接");
  const products = limit > 0 ? allProducts.slice(0, limit) : allProducts;
  return {
    products,
    sourceHash,
    stats: {
      sourceRows,
      duplicateRows,
      duplicateSellerIds: 0,
      uniqueStores: 0,
      appliedLimit: limit,
      inputKind: "asin_links_b",
      duplicateAsins,
      uniqueProductAsins: products.length,
    },
  };
}
