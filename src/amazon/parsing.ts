import { createHash } from "node:crypto";
import { parseHTML } from "linkedom";
import type { StoreAsinOccurrence, StorePageParseResult } from "../shared/types.js";

export interface StoreCardSnapshot {
  asin: string;
  title: string;
  listingHref: string;
  imageUrl: string;
  reviewText: string;
  ratingText: string;
  priceText: string;
}

export interface StoreDocumentSnapshot {
  status: number;
  url: string;
  blocked: boolean;
  hasSearch: boolean;
  zeroResults: boolean;
  displayedName: string;
  resultSummaryText: string;
  nextHref: string;
  paginationTexts: string[];
  cards: StoreCardSnapshot[];
  responseBytes: number;
  fetchMs: number;
  contentType: string;
  declaredLength: number | null;
}

function cleanText(value: string | null | undefined): string {
  return (value ?? "").replace(/[\u200e\u200f\u202a-\u202e]/g, "").replace(/\s+/g, " ").trim();
}

export function parseCount(value: string | null | undefined): number | null {
  const text = cleanText(value).toUpperCase();
  if (!text) return null;
  const match = text.match(/(\d[\d,.]*)(?:\s*)([KM])?/);
  if (!match?.[1]) return null;
  const suffix = match[2] ?? "";
  const numericText = suffix ? match[1].replace(",", ".") : match[1].replace(/[,.]/g, "");
  const number = Number(numericText);
  if (!Number.isFinite(number)) return null;
  return Math.round(number * (suffix === "K" ? 1_000 : suffix === "M" ? 1_000_000 : 1));
}

export function parseRating(value: string | null | undefined): number | null {
  const match = cleanText(value).match(/(\d+(?:[.,]\d+)?)/);
  if (!match?.[1]) return null;
  const number = Number(match[1].replace(",", "."));
  return Number.isFinite(number) && number >= 0 && number <= 5 ? number : null;
}

export function parseFirstGbpPence(value: string | null | undefined): number | null {
  const match = cleanText(value).match(/(?:£|GBP\s*)(\d[\d,]*(?:\.\d{1,2})?)/i);
  if (!match?.[1]) return null;
  const numeric = Number(match[1].replace(/,/g, ""));
  return Number.isFinite(numeric) ? Math.round(numeric * 100) : null;
}

export function canonicalProductUrl(marketplace: string, asin: string): string {
  return new URL(`/dp/${asin}`, marketplace).toString();
}

function amazonUkHost(hostname: string): boolean { return hostname === "amazon.co.uk" || hostname.endsWith(".amazon.co.uk"); }

export function validateNextStoreUrl(href: string, currentUrl: string, sellerId: string, currentPage: number, marketplaceId: string): string {
  try {
    const next = new URL(href, currentUrl);
    const nextSeller = (next.searchParams.get("me") ?? "").toUpperCase();
    const nextPage = Number(next.searchParams.get("page") ?? "0");
    if (!amazonUkHost(next.hostname.toLowerCase()) || nextSeller !== sellerId.toUpperCase() || next.searchParams.get("marketplaceID") !== marketplaceId || !Number.isInteger(nextPage) || nextPage !== currentPage + 1) return "";
    next.hash = "";
    return next.toString();
  } catch { return ""; }
}

export function validateStoreResponseUrl(href: string, sellerId: string, page: number, marketplaceId: string): string {
  try {
    const response = new URL(href);
    const responseSeller = (response.searchParams.get("me") ?? "").toUpperCase();
    const responsePageText = response.searchParams.get("page");
    const responsePage = responsePageText === null && page === 1 ? 1 : Number(responsePageText ?? "0");
    if (!amazonUkHost(response.hostname.toLowerCase()) || responseSeller !== sellerId.toUpperCase()
      || response.searchParams.get("marketplaceID") !== marketplaceId || responsePage !== page) {
      return `Response URL does not match seller ${sellerId}, marketplace ${marketplaceId}, page ${page}`;
    }
    return "";
  } catch {
    return "Response URL is not a valid URL";
  }
}

function blockedDocument(document: Document, status: number): boolean {
  const text = cleanText(document.body?.textContent).toLocaleLowerCase("en-GB");
  const html = document.documentElement?.innerHTML.toLowerCase() ?? "";
  return status === 202 || status === 429 || status === 503 || Boolean(document.querySelector("#captchacharacters, form[action*='validateCaptcha']"))
    || text.includes("enter the characters you see below") || text.includes("sorry, we just need to make sure you're not a robot")
    || html.includes("awswaf") || html.includes("challenge.js") || html.includes("mp_verify");
}

export interface ResultSummary {
  start: number | null;
  end: number | null;
  total: number | null;
}

export function parseResultSummary(value: string | null | undefined): ResultSummary {
  const text = cleanText(value);
  const ranged = text.match(/(\d[\d,]*)\s*[-–]\s*(\d[\d,]*)\s+of\s+(?:(over|about|more than|approximately)\s+)?(\d[\d,]*)(\+)?\s+results?\b/i);
  if (ranged?.[1] && ranged[2] && ranged[4]) {
    const start = Number(ranged[1].replaceAll(",", ""));
    const end = Number(ranged[2].replaceAll(",", ""));
    const total = Number(ranged[4].replaceAll(",", ""));
    if (Number.isSafeInteger(start) && Number.isSafeInteger(end) && Number.isSafeInteger(total) && start >= 1 && end >= start) {
      return { start, end, total: ranged[3] || ranged[5] ? null : total };
    }
  }
  const totalMatch = text.match(/\b(?:(over|about|more than|approximately)\s+)?(\d[\d,]*)(\+)?\s+results?\b/i);
  if (!totalMatch?.[2] || totalMatch[1] || totalMatch[3]) return { start: null, end: null, total: null };
  const total = Number(totalMatch[2].replaceAll(",", ""));
  return { start: null, end: null, total: Number.isSafeInteger(total) && total >= 0 ? total : null };
}

export function parseExactResultTotal(value: string | null | undefined): number | null {
  return parseResultSummary(value).total;
}

export function parseVisibleLastPage(values: readonly string[]): number | null {
  const pages = values.map((value) => cleanText(value)).filter((value) => /^\d{1,5}$/.test(value)).map(Number).filter((value) => Number.isSafeInteger(value) && value >= 1);
  return pages.length > 0 ? Math.max(...pages) : null;
}

function empty(kind: StorePageParseResult["kind"], error: string, snapshot: StoreDocumentSnapshot): StorePageParseResult {
  return {
    kind, error, occurrences: [], displayedName: "", responseUrl: snapshot.url, responseIdentityError: "", nextUrl: "", signature: "", zeroResults: false,
    rawCardCount: snapshot.cards.length, resultRangeStart: null, resultRangeEnd: null, visibleLastPage: null,
    httpStatus: snapshot.status, responseBytes: snapshot.responseBytes, fetchMs: snapshot.fetchMs,
    reportedTotal: null, endpointPort: 0, completenessError: "",
  };
}

function cardText(card: Element, selectors: string): string { return cleanText(card.querySelector(selectors)?.textContent); }

function resultSummaryText(document: Document): string {
  const search = document.querySelector("#search");
  if (!search) return "";
  return [...search.querySelectorAll("span, h1, h2")]
    .map((node) => cleanText(node.textContent))
    .filter((text) => /\b(?:of\s+)?\d[\d,]*\s+results?\b/i.test(text) && text.length <= 300)
    .slice(0, 10)
    .join(" ");
}

function firstGbpPriceText(card: Element): string {
  for (const node of card.querySelectorAll(".a-price .a-offscreen")) {
    const value = cleanText(node.textContent);
    if (/(?:£|GBP\s*)\d/i.test(value)) return value;
  }
  return "";
}

export function normalizeStoreSnapshot(snapshot: StoreDocumentSnapshot, sellerId: string, page: number, marketplace: string, marketplaceId: string): StorePageParseResult {
  const occurrences: StoreAsinOccurrence[] = [];
  for (const card of snapshot.cards) {
    const asin = card.asin.trim().toUpperCase();
    if (!/^[A-Z0-9]{10}$/.test(asin)) continue;
    let listingProductUrl = "";
    try { listingProductUrl = card.listingHref ? new URL(card.listingHref, marketplace).toString() : ""; } catch { listingProductUrl = ""; }
    const priceText = cleanText(card.priceText);
    occurrences.push({
      sellerId, asin, page, position: occurrences.length + 1, title: cleanText(card.title), listingProductUrl,
      productUrl: canonicalProductUrl(marketplace, asin), imageUrl: cleanText(card.imageUrl), reviewCount: parseCount(card.reviewText),
      rating: parseRating(card.ratingText), priceText, pricePence: parseFirstGbpPence(priceText),
    });
  }
  if (snapshot.status === 404 || snapshot.status === 410) return empty("unavailable", `Store page unavailable (HTTP ${snapshot.status})`, snapshot);
  if (snapshot.blocked || snapshot.status === 202) return empty("blocked", `Amazon blocked store page (HTTP ${snapshot.status})`, snapshot);
  if (snapshot.status >= 200 && snapshot.status < 300 && (occurrences.length > 0 || (snapshot.hasSearch && snapshot.zeroResults))) {
    const nextUrl = snapshot.nextHref ? validateNextStoreUrl(snapshot.nextHref, snapshot.url, sellerId, page, marketplaceId) : "";
    const summary = snapshot.zeroResults ? { start: null, end: null, total: 0 } : parseResultSummary(snapshot.resultSummaryText);
    return {
      kind: "success", error: "", occurrences, displayedName: cleanText(snapshot.displayedName),
      responseUrl: snapshot.url,
      responseIdentityError: validateStoreResponseUrl(snapshot.url, sellerId, page, marketplaceId),
      nextUrl,
      signature: createHash("sha256").update(occurrences.map((row) => row.asin).join("\n")).digest("hex"), zeroResults: snapshot.zeroResults,
      rawCardCount: snapshot.cards.length,
      resultRangeStart: summary.start,
      resultRangeEnd: summary.end,
      resultSummaryText: snapshot.resultSummaryText,
      visibleLastPage: parseVisibleLastPage(snapshot.paginationTexts),
      httpStatus: snapshot.status, responseBytes: snapshot.responseBytes, fetchMs: snapshot.fetchMs,
      reportedTotal: summary.total, endpointPort: 0,
      completenessError: snapshot.nextHref && !nextUrl ? "Invalid or non-sequential Next URL" : "",
    };
  }
  if (snapshot.status >= 200 && snapshot.status < 300) {
    return empty("invalid_structure", `Store page has no recognized result structure (HTTP ${snapshot.status})`, snapshot);
  }
  return empty("error", `Unexpected store page response (HTTP ${snapshot.status})`, snapshot);
}

export function parseStorePage(html: string, status: number, requestUrl: string, sellerId: string, page: number, marketplace: string, marketplaceId: string): StorePageParseResult {
  const document = parseHTML(html).document as unknown as Document;
  const search = document.querySelector("#search");
  return normalizeStoreSnapshot({
    status, url: requestUrl, blocked: blockedDocument(document, status), hasSearch: Boolean(search),
    zeroResults: Boolean(search) && /\b(?:no|0)\s+(?:matching\s+)?results?\b/i.test(cleanText(search?.textContent)),
    displayedName: cardText(document.documentElement, "[data-testid='store-name'], [data-store-name], .store-name, #seller-name"),
    resultSummaryText: resultSummaryText(document),
    nextHref: document.querySelector("a.s-pagination-next:not(.s-pagination-disabled)")?.getAttribute("href") ?? "",
    paginationTexts: [...document.querySelectorAll(".s-pagination-strip .s-pagination-item")].map((node) => cleanText(node.textContent)),
    cards: [...document.querySelectorAll<HTMLElement>("[data-component-type='s-search-result'][data-asin]")].map((card) => {
      const image = card.querySelector("img.s-image, img[data-image-latency]");
      return { asin: card.dataset.asin ?? "", title: cardText(card, "h2 span, h2"), listingHref: card.querySelector("h2 a, a.a-link-normal.s-no-outline")?.getAttribute("href") ?? "", imageUrl: cleanText(image?.getAttribute("src") || image?.getAttribute("data-src")), reviewText: cardText(card, ".s-underline-text, a[href*='#customerReviews'] span, [aria-label*='ratings']"), ratingText: cardText(card, "i.a-icon-star-small span.a-icon-alt, span.a-icon-alt"), priceText: firstGbpPriceText(card) };
    }), responseBytes: Buffer.byteLength(html, "utf8"), fetchMs: 0, contentType: "text/html", declaredLength: Buffer.byteLength(html, "utf8"),
  }, sellerId, page, marketplace, marketplaceId);
}
