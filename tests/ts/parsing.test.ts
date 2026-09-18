import { describe, expect, it } from "vitest";
import { normalizeStoreSnapshot, parseCount, parseFirstGbpPence, parseRating } from "../../src/amazon/parsing.js";

describe("Amazon store parsing", () => {
  it.each([["£6.99", 699], ["GBP 50.00", 5000], ["from £9.40 (£2.00/count)", 940], ["$9.99", null], ["", null]])("parses the first GBP amount in %s", (text, expected) => expect(parseFirstGbpPence(text)).toBe(expected));
  it("parses localized counts and ratings", () => {
    expect(parseCount("1.2K ratings")).toBe(1200);
    expect(parseCount("300 ratings")).toBe(300);
    expect(parseRating("4.6 out of 5 stars")).toBe(4.6);
  });
  it("keeps raw price and exact pence on each occurrence", () => {
    const result = normalizeStoreSnapshot({ status: 200, url: "https://www.amazon.co.uk/s?me=A123456789&marketplaceID=A1F83G8C2ARO7P", blocked: false, hasSearch: true, zeroResults: false, displayedName: "Store", resultSummaryText: "1-1 of 1 result", nextHref: "", paginationTexts: ["1"], cards: [{ asin: "B012345678", title: "P", listingHref: "/dp/B012345678", imageUrl: "i", reviewText: "300", ratingText: "3.6", priceText: "£6.99 (£1.00 / count)" }], responseBytes: 1000, fetchMs: 50, contentType: "text/html", declaredLength: 1000 }, "A123456789", 1, "https://www.amazon.co.uk", "A1F83G8C2ARO7P");
    expect(result.occurrences[0]).toMatchObject({ priceText: "£6.99 (£1.00 / count)", pricePence: 699, reviewCount: 300, rating: 3.6, productUrl: "https://www.amazon.co.uk/dp/B012345678" });
  });
});
