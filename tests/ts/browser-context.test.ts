import { describe, expect, it, vi } from "vitest";
import type { BrowserContext, Page, Response } from "playwright";
import { AmazonPostcodeUiUnavailableError, configureAmazonCurrency, configureAmazonPostcode } from "../../src/browser/context.js";
import { runFixture } from "./helpers.js";

function postcodePage(responseBody: Record<string, unknown>, locationText = "London WC1E 7", showInputOnClick = true) {
  let inputVisible = false;
  const locators = new Map<string, {
    first: ReturnType<typeof vi.fn>;
    isVisible: ReturnType<typeof vi.fn>;
    click: ReturnType<typeof vi.fn>;
    waitFor: ReturnType<typeof vi.fn>;
    fill: ReturnType<typeof vi.fn>;
    textContent: ReturnType<typeof vi.fn>;
    count: ReturnType<typeof vi.fn>;
    innerText: ReturnType<typeof vi.fn>;
  }>();
  const locator = vi.fn((selector: string) => {
    const existing = locators.get(selector);
    if (existing) return existing;
    const api = {
      first: vi.fn(),
      isVisible: vi.fn(async () => {
        if (selector === "#sp-cc-rejectall-link" || selector === "#GLUXConfirmClose" || selector.includes("captchacharacters")) return false;
        if (selector === "#GLUXZipUpdateInput") return inputVisible;
        return true;
      }),
      click: vi.fn(async () => {
        if (selector === "#nav-global-location-popover-link" && showInputOnClick) inputVisible = true;
      }),
      waitFor: vi.fn(async () => {
        if (selector === "#GLUXZipUpdateInput" && !inputVisible) throw new Error("postcode input hidden");
      }),
      fill: vi.fn(async () => undefined),
      textContent: vi.fn(async () => selector === "#glow-ingress-line2" ? locationText : ""),
      count: vi.fn(async () => selector === "#GLUXZipUpdateInput" && inputVisible ? 1 : 0),
      innerText: vi.fn(async () => ""),
    };
    api.first.mockReturnValue(api);
    locators.set(selector, api);
    return api;
  });
  const response = {
    url: () => "https://www.amazon.co.uk/portal-migration/hz/glow/address-change?actionSource=glow",
    status: () => 200,
    json: vi.fn(async () => responseBody),
  } as unknown as Response;
  const page = {
    locator,
    waitForResponse: vi.fn(async (predicate: (response: Response) => boolean) => {
      expect(predicate(response)).toBe(true);
      return response;
    }),
    reload: vi.fn(async () => null),
    url: vi.fn(() => "https://www.amazon.co.uk/"),
    title: vi.fn(async () => "Amazon.co.uk"),
    waitForLoadState: vi.fn(async () => undefined),
    waitForTimeout: vi.fn(async () => undefined),
    evaluate: vi.fn(async () => ({
      path: "/",
      title: "Amazon.co.uk",
      locationButtonVisible: true,
      postcodeInputAttached: false,
      dialogVisible: false,
      captchaVisible: false,
      blockMarker: false,
    })),
  } as unknown as Page;
  return { page, locators };
}

describe("Amazon GBP session", () => {
  it("clears every domain variant and verifies one canonical GBP cookie", async () => {
    const { store, config } = runFixture();
    let cookies = [{ name: "i18n-prefs", value: "HKD", domain: ".amazon.co.uk", path: "/" }, { name: "i18n-prefs", value: "GBP", domain: "www.amazon.co.uk", path: "/" }];
    const context = {
      clearCookies: vi.fn(async () => { cookies = []; }),
      addCookies: vi.fn(async (items: Parameters<BrowserContext["addCookies"]>[0]) => { cookies.push(...items.map((item) => ({ name: item.name, value: item.value, domain: item.domain!, path: item.path! }))); }),
      cookies: vi.fn(async () => cookies),
    };
    await configureAmazonCurrency(context as unknown as BrowserContext, config);
    expect(context.clearCookies).toHaveBeenCalledWith({ name: "i18n-prefs", domain: expect.any(RegExp) });
    expect(cookies).toEqual([{ name: "i18n-prefs", value: "GBP", domain: ".amazon.co.uk", path: "/" }]);
    store.close();
  });

  it("rejects an empty postcode response instead of accepting HTTP 200 as success", async () => {
    const { store, config } = runFixture();
    const { page } = postcodePage({});
    await expect(configureAmazonPostcode(page, config, 7902)).rejects.toThrow("did not confirm the address update");
    store.close();
  });

  it("rejects a confirmed response when the rendered delivery location is not the configured postcode", async () => {
    const { store, config } = runFixture();
    const { page } = postcodePage({ isValidAddress: 1, isAddressUpdated: 1, successful: 1 }, "United States");
    await expect(configureAmazonPostcode(page, config, 7902)).rejects.toThrow("did not render WC1E 7");
    store.close();
  });

  it("uses the Amazon location UI and requires response plus rendered-postcode confirmation", async () => {
    const { store, config } = runFixture();
    const { page, locators } = postcodePage({ isValidAddress: 1, isAddressUpdated: 1, successful: 1 });
    await configureAmazonPostcode(page, config, 7902);
    expect(locators.get("#GLUXZipUpdateInput")?.fill).toHaveBeenCalledWith("WC1E 7HU");
    expect(locators.get("#nav-global-location-popover-link")?.click).toHaveBeenCalledOnce();
    expect(page.waitForResponse).toHaveBeenCalledOnce();
    expect(page.reload).toHaveBeenCalledOnce();
    store.close();
  });

  it("accepts Amazon's compact rendered postcode format", async () => {
    const { store, config } = runFixture();
    const { page } = postcodePage({ isValidAddress: 1, isAddressUpdated: 1, successful: 1 }, "London WC1E7HU\u200c");
    await expect(configureAmazonPostcode(page, config, 7902)).resolves.toBeUndefined();
    store.close();
  });

  it("classifies a missing postcode UI with sanitized page diagnostics", async () => {
    const { store, config } = runFixture();
    const { page, locators } = postcodePage({}, "London WC1E 7", false);
    const error = await configureAmazonPostcode(page, config, 7903).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AmazonPostcodeUiUnavailableError);
    expect(error).toMatchObject({ code: "AMAZON_POSTCODE_UI_UNAVAILABLE" });
    expect(String(error)).toContain('\"path\":\"/\"');
    expect(String(error)).toContain('\"captchaVisible\":false');
    expect(locators.get("#nav-global-location-popover-link")?.click).toHaveBeenCalledOnce();
    store.close();
  });
});
