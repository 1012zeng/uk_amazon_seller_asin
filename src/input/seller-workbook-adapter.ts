import ExcelJS from "exceljs";
import type { DetectedSellerSourceLayout, DetectedSourceColumn } from "../shared/types.js";

const SELLER_NAME_HEADERS = ["店铺", "BuyBox卖家"] as const;
const SELLER_PROFILE_HEADERS = ["卖家首页", "卖家链接"] as const;

function normalized(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function columnLetter(column: number): string {
  let value = column;
  let result = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    value = Math.floor((value - 1) / 26);
  }
  return result;
}

function locateHeader(
  sheet: ExcelJS.Worksheet,
  aliases: readonly string[],
  fieldLabel: string,
): DetectedSourceColumn {
  const matches: DetectedSourceColumn[] = [];
  for (let column = 1; column <= sheet.columnCount; column += 1) {
    const header = normalized(sheet.getCell(1, column).text);
    if (!aliases.includes(header)) continue;
    matches.push({ header, column, columnLetter: columnLetter(column) });
  }
  if (matches.length === 0) {
    throw new Error(`源 Excel 表头不匹配：第 1 行缺少${fieldLabel}列，允许表头为“${aliases.join("”或“")}”`);
  }
  if (matches.length > 1) {
    const locations = matches.map((match) => `${match.columnLetter}“${match.header}”`).join("、");
    throw new Error(`源 Excel 表头不匹配：检测到多个${fieldLabel}列：${locations}`);
  }
  return matches[0]!;
}

export function detectSellerWorkbookLayout(sheet: ExcelJS.Worksheet): DetectedSellerSourceLayout {
  return {
    sheet: sheet.name,
    headerRow: 1,
    sellerName: locateHeader(sheet, SELLER_NAME_HEADERS, "卖家名称"),
    sellerProfileUrl: locateHeader(sheet, SELLER_PROFILE_HEADERS, "卖家链接"),
  };
}

function cellKind(value: ExcelJS.CellValue): "empty" | "text" | "hyperlink" | "formula" | "rich" | "other" {
  if (value === null || value === undefined || value === "") return "empty";
  if (typeof value === "string") return "text";
  if (typeof value === "object" && "formula" in value) return "formula";
  if (typeof value === "object" && "richText" in value) return "rich";
  if (typeof value === "object" && "hyperlink" in value) return "hyperlink";
  return "other";
}

function readCell(
  sheet: ExcelJS.Worksheet,
  row: number,
  source: DetectedSourceColumn,
  hyperlinkTarget: boolean,
): string {
  const cell = sheet.getCell(row, source.column);
  const kind = cellKind(cell.value);
  const location = `${source.columnLetter} 列“${source.header}”`;
  if (kind === "formula" || kind === "rich") throw new Error(`第 ${row} 行 ${location}不允许公式或富文本`);
  let result = "";
  if (kind === "text") result = normalized(cell.value as string);
  if (kind === "hyperlink") {
    const value = cell.value as ExcelJS.CellHyperlinkValue;
    result = normalized(String(hyperlinkTarget ? value.hyperlink ?? "" : value.text ?? ""));
  }
  if (kind === "empty" || ((kind === "text" || kind === "hyperlink") && !result)) throw new Error(`第 ${row} 行 ${location}为空`);
  if (kind === "text" || kind === "hyperlink") return result;
  throw new Error(`第 ${row} 行 ${location}数据类型无效`);
}

export function readSellerWorkbookRow(
  sheet: ExcelJS.Worksheet,
  layout: DetectedSellerSourceLayout,
  row: number,
): { name: string; profileUrl: string } {
  return {
    name: readCell(sheet, row, layout.sellerName, false),
    profileUrl: readCell(sheet, row, layout.sellerProfileUrl, true),
  };
}
