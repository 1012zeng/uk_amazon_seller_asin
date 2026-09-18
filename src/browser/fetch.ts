import type { Page } from "playwright";
import type { StoreDocumentSnapshot } from "../amazon/parsing.js";

export interface BrowserDocument {
  status: number;
  url: string;
  html: string;
  responseBytes: number;
  fetchMs: number;
  contentType: string;
  declaredLength: number | null;
}

export function validateStoreResponseEnvelope(contentType: string, declaredLength: number | null, actualLength: number, maxResponseBytes: number): void {
  if (!/\btext\/html\b/i.test(contentType)) throw new Error(`Unexpected Content-Type: ${contentType || "missing"}`);
  if (declaredLength !== null && (!Number.isSafeInteger(declaredLength) || declaredLength < 0)) throw new Error(`Invalid Content-Length: ${declaredLength}`);
  if (declaredLength !== null && declaredLength > maxResponseBytes) throw new Error(`Response exceeds ${maxResponseBytes} bytes (declared ${declaredLength})`);
  if (actualLength > maxResponseBytes) throw new Error(`Response exceeds ${maxResponseBytes} bytes (actual ${actualLength})`);
}

export async function fetchDocument(page: Page, url: string, timeoutMs: number, maxResponseBytes: number): Promise<BrowserDocument> {
  const document = await page.evaluate(async ({ target, timeout, byteLimit }) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    const started = performance.now();
    try {
      const response = await fetch(target, { credentials: "include", signal: controller.signal, redirect: "follow", cache: "no-store" });
      const contentType = response.headers.get("content-type") ?? "";
      const declaredLengthText = response.headers.get("content-length") ?? "";
      const declaredLength = declaredLengthText ? Number(declaredLengthText) : null;
      if (declaredLength !== null && declaredLength > byteLimit) throw new Error(`Response exceeds ${byteLimit} bytes (declared ${declaredLength})`);
      const body = await response.arrayBuffer();
      if (body.byteLength > byteLimit) throw new Error(`Response exceeds ${byteLimit} bytes (actual ${body.byteLength})`);
      return {
        status: response.status,
        url: response.url,
        html: new TextDecoder().decode(body),
        responseBytes: body.byteLength,
        fetchMs: Math.max(0, Math.round(performance.now() - started)),
        contentType,
        declaredLength,
      };
    } finally {
      clearTimeout(timer);
    }
  }, { target: url, timeout: timeoutMs, byteLimit: maxResponseBytes });
  validateStoreResponseEnvelope(document.contentType, document.declaredLength, document.responseBytes, maxResponseBytes);
  return document;
}

export async function fetchStoreSnapshot(page: Page, url: string, timeoutMs: number, maxResponseBytes: number): Promise<StoreDocumentSnapshot> {
  const snapshot = await page.evaluate(async ({ target, timeout, byteLimit }) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    const started = performance.now();
    try {
      const response = await fetch(target, { credentials: "include", signal: controller.signal, redirect: "follow", cache: "no-store" });
      const contentType = response.headers.get("content-type") ?? "";
      if (!/\btext\/html\b/i.test(contentType)) throw new Error(`Unexpected Content-Type: ${contentType || "missing"}`);
      const declaredLengthText = response.headers.get("content-length") ?? "";
      const declaredLength = declaredLengthText ? Number(declaredLengthText) : null;
      if (declaredLength !== null && (!Number.isSafeInteger(declaredLength) || declaredLength < 0)) throw new Error(`Invalid Content-Length: ${declaredLengthText}`);
      if (declaredLength !== null && declaredLength > byteLimit) throw new Error(`Response exceeds ${byteLimit} bytes (declared ${declaredLength})`);
      const body = await response.arrayBuffer();
      if (body.byteLength > byteLimit) throw new Error(`Response exceeds ${byteLimit} bytes (actual ${body.byteLength})`);
      const html = new TextDecoder().decode(body);
      const document = new DOMParser().parseFromString(html, "text/html");
      const clean = Function(
        "value",
        "return (value ?? '').replace(/[\\u200e\\u200f\\u202a-\\u202e]/g, '').replace(/\\s+/g, ' ').trim();",
      ) as (value: string | null | undefined) => string;
      const bodyText = clean(document.body?.textContent).toLocaleLowerCase("en-GB");
      const search = document.querySelector("#search");
      const resultSummaryText = search ? [...search.querySelectorAll("span, h1, h2")]
        .map((node) => clean(node.textContent))
        .filter((text) => /\b(?:of\s+)?\d[\d,]*\s+results?\b/i.test(text) && text.length <= 300)
        .slice(0, 10)
        .join(" ") : "";
      return {
        status: response.status,
        url: response.url,
        blocked: response.status === 202 || response.status === 429 || response.status === 503
          || Boolean(document.querySelector("#captchacharacters, form[action*='validateCaptcha']"))
          || bodyText.includes("enter the characters you see below")
          || bodyText.includes("sorry, we just need to make sure you're not a robot")
          || html.toLowerCase().includes("awswaf") || html.toLowerCase().includes("challenge.js") || html.toLowerCase().includes("mp_verify"),
        hasSearch: Boolean(search),
        zeroResults: Boolean(search) && /\b(?:no|0)\s+(?:matching\s+)?results?\b/i.test(clean(search?.textContent)),
        displayedName: clean(document.querySelector("[data-testid='store-name'], [data-store-name], .store-name, #seller-name")?.textContent),
        resultSummaryText,
        nextHref: document.querySelector("a.s-pagination-next:not(.s-pagination-disabled)")?.getAttribute("href") ?? "",
        paginationTexts: [...document.querySelectorAll(".s-pagination-strip .s-pagination-item")].map((node) => clean(node.textContent)),
        cards: [...document.querySelectorAll<HTMLElement>("[data-component-type='s-search-result'][data-asin]")].map((card) => {
          const image = card.querySelector("img.s-image, img[data-image-latency]");
          return {
            asin: card.dataset.asin ?? "",
            title: clean(card.querySelector("h2 span, h2")?.textContent),
            listingHref: card.querySelector("h2 a, a.a-link-normal.s-no-outline")?.getAttribute("href") ?? "",
            imageUrl: clean(image?.getAttribute("src") || image?.getAttribute("data-src")),
            reviewText: clean(card.querySelector(".s-underline-text, a[href*='#customerReviews'] span, [aria-label*='ratings']")?.textContent),
            ratingText: clean(card.querySelector("i.a-icon-star-small span.a-icon-alt, span.a-icon-alt")?.textContent),
            priceText: [...card.querySelectorAll(".a-price .a-offscreen")].map((node) => clean(node.textContent)).find((value) => /(?:£|GBP\s*)\d/i.test(value)) ?? "",
          };
        }), responseBytes: body.byteLength, fetchMs: Math.max(0, Math.round(performance.now() - started)), contentType, declaredLength,
      };
    } finally {
      clearTimeout(timer);
    }
  }, { target: url, timeout: timeoutMs, byteLimit: maxResponseBytes });
  validateStoreResponseEnvelope(snapshot.contentType, snapshot.declaredLength, snapshot.responseBytes, maxResponseBytes);
  return snapshot;
}
