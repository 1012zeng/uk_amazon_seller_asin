import type { AppConfig } from "./types.js";

type ListingAgeBandConfig = Pick<AppConfig["filters"],
  "maxNewAgeDays" | "firstChildSalesBandMaxAgeDays" | "secondChildSalesBandMaxAgeDays" | "maxAgeDays">;

export interface ListingAgeBand {
  sheetName: string;
  minimumAgeDays: number;
  maximumAgeDays: number;
}

export function listingAgeDays(availableDate: string, asOfDate: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(availableDate)) return null;
  const available = new Date(`${availableDate}T00:00:00.000Z`);
  const asOf = new Date(`${asOfDate}T00:00:00.000Z`);
  if (!Number.isFinite(available.getTime()) || available.toISOString().slice(0, 10) !== availableDate) return null;
  return Math.floor((asOf.getTime() - available.getTime()) / 86_400_000);
}

export function listingAgeBands(filters: ListingAgeBandConfig): ListingAgeBand[] {
  const boundaries = [filters.maxNewAgeDays, filters.firstChildSalesBandMaxAgeDays, filters.secondChildSalesBandMaxAgeDays, filters.maxAgeDays];
  if (boundaries.some((value, index) => value < 0 || (index > 0 && value <= boundaries[index - 1]!))) {
    throw new Error("Listing age boundaries must be strictly increasing non-negative integers");
  }
  return boundaries.map((maximumAgeDays, index) => {
    const minimumAgeDays = index === 0 ? 0 : boundaries[index - 1]! + 1;
    return { sheetName: `${minimumAgeDays}-${maximumAgeDays}天`, minimumAgeDays, maximumAgeDays };
  });
}
