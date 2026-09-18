import { afterEach, describe, expect, it, vi } from "vitest";
import { SellerSpriteClient } from "../../src/mcp/client.js";
import { runFixture } from "./helpers.js";

afterEach(() => vi.unstubAllGlobals());

function salesResponse(asin: string, result: string, total: number, dailySalesMinimum: number): Record<string, unknown> {
  return {
    request_id: "r",
    marketplace: "UK",
    asin,
    data_type: "prediction",
    daily_sales_minimum: dailySalesMinimum,
    window_start: "2026-08-06",
    window_end: "2026-08-12",
    complete: true,
    dailyItemList: Array.from({ length: 7 }, (_, index) => ({
      date: new Date(Date.UTC(2026, 7, 6 + index)).toISOString().slice(0, 10),
      sales: index === 0 ? total : 0,
    })),
    result,
  };
}

function lookupItem(asin: string, status: "ok" | "not_found" = "not_found"): Record<string, unknown> {
  return {
    asin, status, error_code: null, error_message: null,
    title: status === "ok" ? "Example product" : null,
    nodeLabelPath: status === "ok" ? "Home & Kitchen:Storage" : null,
    brand: status === "ok" ? "Example Brand" : null,
    brandUrl: status === "ok" ? "https://www.amazon.co.uk/example-brand" : null,
    image_url: null, bsr_rank: null, child_sales_30d: null, available_date: null,
    fulfillment: null, variation_count: null, buybox_seller_id: null, buybox_seller_name: null,
  };
}

describe("strict MCP protocol validation", () => {
  it("rejects counter drift", async () => {
    const { store, config } = runFixture();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ request_id: "r", marketplace: "UK", request_count: 1, success_count: 1, not_found_count: 0, error_count: 0, partial: true, items: [lookupItem("B000000001")] }),
      { status: 200, headers: { "content-type": "application/json" } },
    )));
    await expect(new SellerSpriteClient(config).competitorLookup(["B000000001"])).rejects.toThrow(/counters/i);
    store.close();
  });

  it("rejects ASIN order drift", async () => {
    const { store, config } = runFixture();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ request_id: "r", marketplace: "UK", request_count: 1, success_count: 0, not_found_count: 1, error_count: 0, partial: true, items: [lookupItem("B000000002")] }), { status: 200, headers: { "content-type": "application/json" } })));
    await expect(new SellerSpriteClient(config).competitorLookup(["B000000001"])).rejects.toThrow(/order or value/i);
    store.close();
  });

  it("uses exact yes or No without recalculating the seven-day sum", async () => {
    const { store, config } = runFixture();
    const requestBodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (_input: unknown, init?: RequestInit) => {
      const requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requestBodies.push(requestBody);
      const asin = String(requestBody.asin);
      const dailySalesMinimum = Number(requestBody.daily_sales_minimum);
      const body = asin === "B000000001" ? salesResponse(asin, "yes", 21, dailySalesMinimum) : salesResponse(asin, "No", 700, dailySalesMinimum);
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }));
    const client = new SellerSpriteClient(config);
    await expect(client.sales7d("B000000001", "2026-08-13", 3)).resolves.toMatchObject({ result: "yes", dailySalesMinimum: 3 });
    await expect(client.sales7d("B000000002", "2026-08-13", 4)).resolves.toMatchObject({ result: "No", dailySalesMinimum: 4 });
    expect(requestBodies).toEqual([
      { marketplace: "UK", asin: "B000000001", as_of_date: "2026-08-13", daily_sales_minimum: 3 },
      { marketplace: "UK", asin: "B000000002", as_of_date: "2026-08-13", daily_sales_minimum: 4 },
    ]);
    store.close();
  });

  it("rejects result casing outside the exact contract", async () => {
    const { store, config } = runFixture();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(salesResponse("B000000001", "Yes", 21, 3)), { status: 200, headers: { "content-type": "application/json" } })));
    await expect(new SellerSpriteClient(config).sales7d("B000000001", "2026-08-13", 3)).rejects.toThrow(/exact yes or No/i);
    store.close();
  });

  it("rejects a daily minimum that is missing or differs from the request", async () => {
    const { store, config } = runFixture();
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(salesResponse("B000000001", "yes", 70, 3)), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...salesResponse("B000000001", "yes", 70, 4), daily_sales_minimum: undefined }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    const client = new SellerSpriteClient(config);
    await expect(client.sales7d("B000000001", "2026-08-13", 4)).rejects.toThrow(/daily minimum/i);
    await expect(client.sales7d("B000000001", "2026-08-13", 4)).rejects.toThrow(/daily_sales_minimum/i);
    store.close();
  });

  it("accepts title, category, brand, and brand URL from competitor lookup", async () => {
    const { store, config } = runFixture();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({
        request_id: "r", marketplace: "UK", request_count: 1, success_count: 1, not_found_count: 0, error_count: 0, partial: false,
        items: [lookupItem("B000000001", "ok")],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )));
    await expect(new SellerSpriteClient(config).competitorLookup(["B000000001"])).resolves.toMatchObject({
      items: [{ title: "Example product", nodeLabelPath: "Home & Kitchen:Storage", brand: "Example Brand", brandUrl: "https://www.amazon.co.uk/example-brand" }],
    });
    store.close();
  });

  it("resolves single-slash Amazon brand paths and rejects protocol-relative URLs", async () => {
    const { store, config } = runFixture();
    const item = lookupItem("B000000001", "ok");
    const response = (brandUrl: string) => new Response(JSON.stringify({
      request_id: "r", marketplace: "UK", request_count: 1, success_count: 1, not_found_count: 0, error_count: 0, partial: false,
      items: [{ ...item, brandUrl }],
    }), { status: 200 });
    const fetch = vi.fn()
      .mockResolvedValueOnce(response("/stores/Example/page/ABC?ref_=brand"))
      .mockResolvedValueOnce(response("//example.invalid/brand"));
    vi.stubGlobal("fetch", fetch);
    const client = new SellerSpriteClient(config);
    await expect(client.competitorLookup(["B000000001"])).resolves.toMatchObject({
      items: [{ brandUrl: "https://www.amazon.co.uk/stores/Example/page/ABC?ref_=brand" }],
    });
    await expect(client.competitorLookup(["B000000001"])).rejects.toThrow(/brandUrl/);
    store.close();
  });

  it("rejects missing brand fields and non-HTTP brand URLs", async () => {
    const { store, config } = runFixture();
    const item = lookupItem("B000000001", "ok");
    const response = (value: Record<string, unknown>) => new Response(JSON.stringify({
      request_id: "r", marketplace: "UK", request_count: 1, success_count: 1, not_found_count: 0, error_count: 0, partial: false, items: [value],
    }), { status: 200 });
    const fetch = vi.fn()
      .mockResolvedValueOnce(response({ ...item, brand: undefined }))
      .mockResolvedValueOnce(response({ ...item, brandUrl: "ftp://example.invalid/brand" }));
    vi.stubGlobal("fetch", fetch);
    const client = new SellerSpriteClient(config);
    await expect(client.competitorLookup(["B000000001"])).rejects.toThrow(/brand/);
    await expect(client.competitorLookup(["B000000001"])).rejects.toThrow(/brandUrl/);
    store.close();
  });

  it("posts one ASIN to asin-detail and preserves features and overview text", async () => {
    const { store, config } = runFixture();
    let requestBody: unknown;
    vi.stubGlobal("fetch", vi.fn(async (_input: unknown, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ request_id: "r", marketplace: "UK", asin: "B000000001", features: ["First", "Second"], overviews: ' {"Brand":"Example"} ' }), { status: 200, headers: { "content-type": "application/json" } });
    }));
    await expect(new SellerSpriteClient(config).asinDetail("b000000001")).resolves.toEqual({ marketplace: "UK", asin: "B000000001", features: ["First", "Second"], overviews: ' {"Brand":"Example"} ' });
    expect(requestBody).toEqual({ marketplace: "UK", asin: "B000000001" });
    store.close();
  });

  it("rejects invalid asin-detail identity and field types", async () => {
    const { store, config } = runFixture();
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ request_id: "r", marketplace: "UK", asin: "B000000002", features: [], overviews: null }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ request_id: "r", marketplace: "UK", asin: "B000000001", features: ["ok", 1], overviews: null }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    const client = new SellerSpriteClient(config);
    await expect(client.asinDetail("B000000001")).rejects.toThrow(/identity/i);
    await expect(client.asinDetail("B000000001")).rejects.toThrow(/features/i);
    store.close();
  });
});
