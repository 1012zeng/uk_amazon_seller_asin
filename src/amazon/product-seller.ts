import { parseHTML } from "linkedom";
import type { BrowserDocument } from "../browser/fetch.js";
import { extractSellerId } from "../input/source-stores.js";
import type { ProductSellerResult } from "../shared/types.js";

function cleanText(value: string | null | undefined): string {
  return (value ?? "").replace(/[\u200e\u200f\u202a-\u202e]/g, "").replace(/\s+/g, " ").trim();
}

function canonicalSellerProfileUrl(marketplace: string, sellerId: string): string {
  const url = new URL("/sp", marketplace);
  url.searchParams.set("seller", sellerId);
  return url.toString();
}

export function parseProductSellerDocument(document: BrowserDocument, marketplace: string): ProductSellerResult {
  const base = { sellerId: "" as const, sellerName: "" as const, sellerProfileUrl: "" as const, httpStatus: document.status, responseBytes: document.responseBytes, fetchMs: document.fetchMs };
  if (document.status === 404 || document.status === 410) return { kind: "unavailable", ...base, error: `Product page unavailable (HTTP ${document.status})` };
  if (document.status === 429 || document.status === 503) return { kind: "blocked", ...base, error: `Amazon blocked product page (HTTP ${document.status})` };
  const parsed = parseHTML(document.html).document as unknown as Document;
  const bodyText = cleanText(parsed.documentElement?.textContent).toLocaleLowerCase("en-GB");
  const blocked = Boolean(parsed.querySelector("#captchacharacters, form[action*='validateCaptcha']"))
    || bodyText.includes("enter the characters you see below")
    || bodyText.includes("sorry, we just need to make sure you're not a robot");
  if (blocked) return { kind: "blocked", ...base, error: `Amazon blocked product page (HTTP ${document.status})` };

  // DEBUG: Log HTML info
  console.log(`[调试] 页面地址：${document.url}，HTML 长度：${document.html.length}`);
  console.log(`[调试] 是否存在 #dp：${Boolean(parsed.querySelector("#dp")) ? "是" : "否"}`);
  console.log(`[调试] 是否存在 #productTitle：${Boolean(parsed.querySelector("#productTitle")) ? "是" : "否"}`);
  console.log(`[调试] 是否存在 #sellerProfileTriggerId：${Boolean(parsed.querySelector("#sellerProfileTriggerId")) ? "是" : "否"}`);
  console.log(`[调试] HTML 中的卖家链接：${document.html.match(/seller=[A-Z0-9]{10,20}/i)?.[0] || "未找到"}`);

  const selectors = [
    "#sellerProfileTriggerId",
    "#merchant-info a[href]",
    "#tabular-buybox a[href]",
    "#desktop_buybox a[href]",
    "#buybox a[href]",
  ];
  for (const selector of selectors) {
    const elements = parsed.querySelectorAll<HTMLAnchorElement>(selector);
    console.log(`[调试] 选择器“${selector}”：找到 ${elements.length} 个元素`);
    for (const anchor of elements) {
      const href = anchor.getAttribute("href") ?? "";
      let absolute = "";
      try { absolute = new URL(href, marketplace).toString(); } catch { continue; }
      const sellerId = extractSellerId(absolute);
      console.log(`[调试] 链接：${href.substring(0, 150)}，卖家编号：${sellerId || "未找到"}`);
      if (!sellerId) continue;
      return {
        kind: "success",
        sellerId,
        sellerName: cleanText(anchor.textContent) || sellerId,
        sellerProfileUrl: canonicalSellerProfileUrl(marketplace, sellerId),
        httpStatus: document.status,
        responseBytes: document.responseBytes,
        fetchMs: document.fetchMs,
        error: "",
      };
    }
  }

  const hasProduct = Boolean(parsed.querySelector("#dp, #ppd, #centerCol, #productTitle, input#ASIN"));
  const error = hasProduct
    ? "Product page has no resolvable marketplace seller link"
    : `Product page has no recognized detail structure (HTTP ${document.status})`;
  return { kind: hasProduct ? "missing" : "blocked", ...base, error };
}
