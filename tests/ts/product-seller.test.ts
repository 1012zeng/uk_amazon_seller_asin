import { describe, expect, it } from "vitest";
import { parseProductSellerDocument } from "../../src/amazon/product-seller.js";
import type { BrowserDocument } from "../../src/browser/fetch.js";

function document(html: string, status = 200): BrowserDocument {
  return { status, url: "https://www.amazon.co.uk/dp/B012345678", html, responseBytes: Buffer.byteLength(html), fetchMs: 12, contentType: "text/html", declaredLength: null };
}

describe("Amazon product seller parsing", () => {
  it("extracts the buy-box seller and produces a canonical profile link", () => {
    const result = parseProductSellerDocument(document(`<html><body><div id="dp"><a id="sellerProfileTriggerId" href="/gp/help/seller/at-a-glance.html?ie=UTF8&seller=A123456789&asin=B012345678">Example Store</a></div></body></html>`), "https://www.amazon.co.uk");
    expect(result).toMatchObject({ kind: "success", sellerId: "A123456789", sellerName: "Example Store", sellerProfileUrl: "https://www.amazon.co.uk/sp?seller=A123456789" });
  });

  it("accepts a seller link inside the tabular buy box", () => {
    const result = parseProductSellerDocument(document(`<html><body><div id="ppd"><div id="tabular-buybox"><a href="/gp/help/seller/at-a-glance.html?me=B123456789">Second</a></div></div></body></html>`), "https://www.amazon.co.uk");
    expect(result).toMatchObject({ kind: "success", sellerId: "B123456789" });
  });

  it("classifies a valid product without a seller link as missing", () => {
    expect(parseProductSellerDocument(document(`<html><body><div id="dp"><span id="productTitle">Product</span></div></body></html>`), "https://www.amazon.co.uk")).toMatchObject({ kind: "missing" });
  });

  it("classifies WAF and unavailable pages before seller extraction", () => {
    expect(parseProductSellerDocument(document(`<form action="/errors/validateCaptcha"></form>`, 503), "https://www.amazon.co.uk")).toMatchObject({ kind: "blocked" });
    expect(parseProductSellerDocument(document("gone", 404), "https://www.amazon.co.uk")).toMatchObject({ kind: "unavailable" });
  });
});
