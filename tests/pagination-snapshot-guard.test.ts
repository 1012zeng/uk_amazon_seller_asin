import { describe, expect, it } from "vitest";
import {
  DEFAULT_PAGINATION_POLICY,
  PaginationSnapshotGuard,
  type PaginationBaseline,
  type PaginationObservation,
} from "../../src/amazon/pagination-snapshot-guard.js";

function observation(patch: Partial<PaginationObservation> = {}): PaginationObservation {
  return {
    page: 1,
    responseIdentityError: "",
    nextIdentityError: "",
    resultCount: 16,
    rawCardCount: 16,
    rangeStart: 1,
    rangeEnd: 16,
    reportedTotal: 113,
    visibleLastPage: 12,
    zeroResults: false,
    hasNext: true,
    nextPage: 2,
    priorPageCount: 0,
    priorOccurrenceCount: 0,
    signatureCollisionPage: null,
    overlapCount: 0,
    adjacentOverlapCount: 0,
    adjacentPageSize: 0,
    ...patch,
  };
}

function baseline(): PaginationBaseline {
  return {
    mode: "fixed_last_page",
    initialReportedTotal: 113,
    expectedLastPage: 12,
    safetyCeiling: 12,
    initialPageSize: 16,
  };
}

const guard = new PaginationSnapshotGuard(DEFAULT_PAGINATION_POLICY);

describe("PaginationSnapshotGuard", () => {
  it("freezes the first page's numeric last page as the crawl ceiling", () => {
    const decision = guard.evaluate({ baseline: null, previousRangeEnd: null, driftVerified: false, reprobe: false, observation: observation() });

    expect(decision).toMatchObject({ action: "accept", nextPage: 2, validationState: "unverified" });
    expect(decision.baseline).toEqual(baseline());
  });

  it("keeps the frozen boundary when reported totals and later pagination change", () => {
    const decision = guard.evaluate({
      baseline: baseline(),
      previousRangeEnd: 96,
      driftVerified: false,
      reprobe: false,
      observation: observation({ page: 7, rangeStart: 97, rangeEnd: 112, reportedTotal: 7000, visibleLastPage: 438, nextPage: 8, priorPageCount: 6, priorOccurrenceCount: 96 }),
    });

    expect(decision).toMatchObject({ action: "accept", nextPage: 8, baseline: baseline() });
    expect(decision.warnings.map((item) => item.code)).toEqual(expect.arrayContaining(["reported_total_changed", "visible_last_page_changed"]));
  });

  it("accepts heavily overlapping pages for deduplication after traversal", () => {
    const input = {
      baseline: baseline(),
      previousRangeEnd: 112,
      driftVerified: false,
      observation: observation({ page: 8, rangeStart: 113, rangeEnd: 128, nextPage: 9, priorPageCount: 7, priorOccurrenceCount: 112, overlapCount: 15, adjacentOverlapCount: 15, adjacentPageSize: 16 }),
    };

    expect(guard.evaluate({ ...input, reprobe: false })).toMatchObject({ action: "accept", nextPage: 9, warnings: [{ code: "cross_page_overlap" }] });
  });

  it("reprobes a page whose displayed ordinal range contains more cards than were parsed", () => {
    const decision = guard.evaluate({
      baseline: { ...baseline(), initialReportedTotal: 268, expectedLastPage: 17, safetyCeiling: 17 },
      previousRangeEnd: 240,
      driftVerified: false,
      reprobe: false,
      observation: observation({ page: 16, resultCount: 13, rawCardCount: 13, rangeStart: 241, rangeEnd: 256, reportedTotal: 260, visibleLastPage: 17, nextPage: 17, priorPageCount: 15, priorOccurrenceCount: 240 }),
    });

    expect(decision).toMatchObject({ action: "reprobe", reasonCode: "result_range_card_mismatch" });
  });

  it("records inventory drift without needing a second page-one request", () => {
    const decision = guard.evaluate({
      baseline: baseline(),
      previousRangeEnd: 16,
      driftVerified: false,
      reprobe: false,
      observation: observation({ page: 2, rangeStart: 17, rangeEnd: 32, reportedTotal: 120, visibleLastPage: 12, nextPage: 3, priorPageCount: 1, priorOccurrenceCount: 16 }),
    });

    expect(decision).toMatchObject({ action: "accept", nextPage: 3, validationState: "verified_drift" });
    expect(decision.warnings.map((warning) => warning.code)).toContain("reported_total_changed");
  });

  it("stops at the frozen numeric last page even when Amazon offers another Next link", () => {
    const decision = guard.evaluate({
      baseline: { ...baseline(), initialReportedTotal: 192 },
      previousRangeEnd: 176,
      driftVerified: false,
      reprobe: false,
      observation: observation({ page: 12, rangeStart: 177, rangeEnd: 192, reportedTotal: 192, hasNext: true, nextPage: 13, priorPageCount: 11, priorOccurrenceCount: 176 }),
    });

    expect(decision).toMatchObject({ action: "complete", nextPage: null, validationState: "verified_drift" });
    expect(decision.warnings.map((warning) => warning.code)).toContain("next_beyond_frozen_last_page");
  });

  it("retains the initial maximum after a large visible-last-page shift", () => {
    const decision = guard.evaluate({
      baseline: baseline(),
      previousRangeEnd: 16,
      driftVerified: false,
      reprobe: false,
      observation: observation({ page: 2, rangeStart: 17, rangeEnd: 32, visibleLastPage: 70, nextPage: 3, priorPageCount: 1, priorOccurrenceCount: 16 }),
    });

    expect(decision).toMatchObject({ action: "accept", nextPage: 3, baseline: baseline(), warnings: [{ code: "visible_last_page_changed" }] });
  });

  it("uses the frozen boundary when subsequent pages omit pagination evidence", () => {
    const input = {
      baseline: baseline(),
      previousRangeEnd: 16,
      driftVerified: false,
      observation: observation({ page: 2, rangeStart: 17, rangeEnd: 32, reportedTotal: null, visibleLastPage: null, nextPage: 3, priorPageCount: 1, priorOccurrenceCount: 16 }),
    };
    expect(guard.evaluate({ ...input, reprobe: false })).toMatchObject({ action: "accept", nextPage: 3, baseline: baseline() });
  });

  it("does not schedule a page beyond a derived fallback ceiling", () => {
    const decision = guard.evaluate({
      baseline: { mode: "derived_ceiling", initialReportedTotal: 32, expectedLastPage: null, safetyCeiling: 6, initialPageSize: 16 },
      previousRangeEnd: 80,
      driftVerified: false,
      reprobe: false,
      observation: observation({ page: 6, rangeStart: 81, rangeEnd: 96, reportedTotal: 32, visibleLastPage: null, nextPage: 7, priorPageCount: 5, priorOccurrenceCount: 80 }),
    });
    expect(decision).toMatchObject({ action: "quarantine", reasonCode: "fallback_safety_ceiling_reached", nextPage: null });
  });

  it("does not truncate a numeric last page at the fallback limit of 400", () => {
    const decision = guard.evaluate({ baseline: null, previousRangeEnd: null, driftVerified: false, reprobe: false, observation: observation({ visibleLastPage: 500 }) });
    expect(decision.baseline).toMatchObject({ expectedLastPage: 500, safetyCeiling: 500 });
  });

  it("still rejects a response belonging to another seller or requested page", () => {
    const decision = guard.evaluate({ baseline: baseline(), previousRangeEnd: null, driftVerified: false, reprobe: false, observation: observation({ responseIdentityError: "Wrong seller" }) });
    expect(decision).toMatchObject({ action: "quarantine", reasonCode: "response_identity_mismatch" });
  });
});
