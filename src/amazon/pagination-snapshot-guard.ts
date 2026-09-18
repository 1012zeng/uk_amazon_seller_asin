export type PaginationMode = "fixed_last_page" | "derived_ceiling";
export type StoreValidationState = "unverified" | "exact" | "verified_drift" | "quarantined";
export type PaginationAction = "accept" | "complete" | "reprobe" | "quarantine";

export interface PaginationPolicy {
  softTotalDriftRatio: number;
  softTotalDriftAbsolute: number;
  hardTotalDriftRatio: number;
  hardTotalDriftAbsolute: number;
  softLastPageDriftRatio: number;
  softLastPageDriftAbsolute: number;
  hardLastPageDriftRatio: number;
  hardLastPageDriftAbsolute: number;
  overlapReprobeRatio: number;
  rangeCardTolerance: number;
  fallbackPageMultiplier: number;
  fallbackPageMargin: number;
  fallbackMaxPages: number;
}

export const DEFAULT_PAGINATION_POLICY: PaginationPolicy = {
  softTotalDriftRatio: 0.05,
  softTotalDriftAbsolute: 5,
  hardTotalDriftRatio: 0.2,
  hardTotalDriftAbsolute: 20,
  softLastPageDriftRatio: 0.05,
  softLastPageDriftAbsolute: 1,
  hardLastPageDriftRatio: 0.2,
  hardLastPageDriftAbsolute: 2,
  overlapReprobeRatio: 0.2,
  rangeCardTolerance: 1,
  fallbackPageMultiplier: 2,
  fallbackPageMargin: 2,
  fallbackMaxPages: 400,
};

export interface PaginationBaseline {
  mode: PaginationMode;
  initialReportedTotal: number | null;
  expectedLastPage: number | null;
  safetyCeiling: number;
  initialPageSize: number;
}

export interface PaginationObservation {
  page: number;
  responseIdentityError: string;
  nextIdentityError: string;
  resultCount: number;
  rawCardCount: number;
  rangeStart: number | null;
  rangeEnd: number | null;
  reportedTotal: number | null;
  visibleLastPage: number | null;
  zeroResults: boolean;
  hasNext: boolean;
  nextPage: number | null;
  priorPageCount: number;
  priorOccurrenceCount: number;
  signatureCollisionPage: number | null;
  overlapCount: number;
  adjacentOverlapCount: number;
  adjacentPageSize: number;
}

export interface PaginationWarning {
  code: string;
  message: string;
}

export interface PaginationEvaluation {
  baseline: PaginationBaseline | null;
  previousRangeEnd: number | null;
  driftVerified: boolean;
  reprobe: boolean;
  baselineProbe?: PaginationObservation;
  configuredMaxPages?: number;
  observation: PaginationObservation;
}

export interface PaginationDecision {
  action: PaginationAction;
  reasonCode: string;
  reason: string;
  warnings: PaginationWarning[];
  baseline: PaginationBaseline | null;
  nextPage: number | null;
  validationState: StoreValidationState;
}

function warning(code: string, message: string): PaginationWarning {
  return { code, message };
}

function threshold(reference: number, ratio: number, absolute: number): number {
  return Math.max(absolute, Math.ceil(reference * ratio));
}

function rangeSize(value: PaginationObservation): number | null {
  if (value.rangeStart === null || value.rangeEnd === null || value.rangeEnd < value.rangeStart) return null;
  return value.rangeEnd - value.rangeStart + 1;
}

function overlapRatio(value: PaginationObservation): number {
  const denominator = Math.max(1, Math.min(value.resultCount, value.adjacentPageSize || value.resultCount));
  return value.adjacentOverlapCount / denominator;
}

export class PaginationSnapshotGuard {
  constructor(private readonly policy: PaginationPolicy) {}

  evaluate(input: PaginationEvaluation): PaginationDecision {
    const current = input.observation;
    if (current.responseIdentityError) return this.stop("response_identity_mismatch", current.responseIdentityError, input.baseline);
    if (current.page < 1) return this.stop("invalid_page_number", "Page must be positive", input.baseline);
    if (!input.baseline && current.page !== 1) return this.stop("missing_first_page_baseline", "The first page must establish the crawl boundary", null);

    const cardError = this.cardError(current);
    if (cardError) return input.reprobe
      ? this.stop(cardError.code, cardError.message, input.baseline)
      : this.reprobe(cardError.code, cardError.message, input.baseline);

    let baseline = input.baseline;
    if (!baseline) {
      const fixedLastPage = current.visibleLastPage;
      const configuredCap = input.configuredMaxPages ?? 0;
      if (fixedLastPage !== null && configuredCap > 0 && configuredCap < fixedLastPage) {
        return this.stop("configured_page_cap_below_observed_last_page", `Configured page cap ${configuredCap} is below observed last page ${fixedLastPage}`, null);
      }
      if (fixedLastPage === null && !current.zeroResults && current.reportedTotal === null && !current.hasNext) {
        return input.reprobe
          ? this.stop("pagination_baseline_missing", "No numeric last page, exact total or valid Next is available", null)
          : this.reprobe("pagination_baseline_missing", "No numeric last page, exact total or valid Next is available", null);
      }
      // A numeric paginator is authoritative. The fallback limit applies only
      // when the first page does not expose a numeric last page.
      const derivedCeiling = current.zeroResults ? 1 : current.reportedTotal === null
        ? this.policy.fallbackMaxPages
        : Math.ceil(current.reportedTotal / Math.max(1, current.resultCount)) * this.policy.fallbackPageMultiplier + this.policy.fallbackPageMargin;
      baseline = {
        mode: fixedLastPage === null ? "derived_ceiling" : "fixed_last_page",
        initialReportedTotal: current.reportedTotal,
        expectedLastPage: fixedLastPage,
        safetyCeiling: fixedLastPage ?? Math.max(1, Math.min(derivedCeiling, configuredCap || this.policy.fallbackMaxPages, this.policy.fallbackMaxPages)),
        initialPageSize: Math.max(1, current.resultCount),
      };
    }
    if (current.page > baseline.safetyCeiling) return this.stop("page_beyond_safety_ceiling", `Page ${current.page} exceeds frozen ceiling ${baseline.safetyCeiling}`, baseline);

    const fixed = baseline.expectedLastPage !== null;
    const terminal = fixed ? current.page === baseline.expectedLastPage : !current.hasNext;
    if (!fixed && current.page === baseline.safetyCeiling && current.hasNext) {
      return this.stop("fallback_safety_ceiling_reached", `Page ${current.page} still exposes Next at fallback ceiling ${baseline.safetyCeiling}`, baseline);
    }
    if (!fixed && current.nextIdentityError) return this.stop("invalid_next", current.nextIdentityError, baseline);

    const warnings: PaginationWarning[] = [];
    if (!current.zeroResults && rangeSize(current) === null) warnings.push(warning("result_range_missing", "Page omitted a result range; the frozen pagination boundary is retained"));
    if (baseline.initialReportedTotal !== null && current.reportedTotal !== null
      && Math.abs(current.reportedTotal - baseline.initialReportedTotal) > threshold(baseline.initialReportedTotal, this.policy.softTotalDriftRatio, this.policy.softTotalDriftAbsolute)) {
      warnings.push(warning("reported_total_changed", `Reported total changed from ${baseline.initialReportedTotal} to ${current.reportedTotal}; pagination remains fixed`));
    }
    if (fixed && current.visibleLastPage !== null && current.visibleLastPage !== baseline.expectedLastPage) {
      warnings.push(warning("visible_last_page_changed", `Visible last page changed to ${current.visibleLastPage}; keeping frozen last page ${baseline.expectedLastPage}`));
    }
    if (current.signatureCollisionPage !== null) warnings.push(warning("repeated_page_signature", `Page repeats page ${current.signatureCollisionPage}; ASINs will be deduplicated after traversal`));
    else if (overlapRatio(current) > this.policy.overlapReprobeRatio) warnings.push(warning("cross_page_overlap", "Overlapping ASINs will be deduplicated after traversal"));
    if (fixed && terminal && current.hasNext) warnings.push(warning("next_beyond_frozen_last_page", `Ignored Next beyond frozen last page ${baseline.expectedLastPage}`));
    if (terminal && baseline.initialReportedTotal !== null && current.priorPageCount === current.page - 1) {
      const captured = current.priorOccurrenceCount + current.resultCount;
      if (captured !== baseline.initialReportedTotal) warnings.push(warning("terminal_count_drift", `Reported total ${baseline.initialReportedTotal} differs from ${captured} captured records; all planned pages were attempted`));
    }

    const nextPage = terminal ? null : fixed ? current.page + 1 : current.nextPage;
    if (!terminal && nextPage === null) return this.stop("missing_next_page_number", "Fallback pagination requires a valid next page number", baseline);
    const warned = input.driftVerified || warnings.length > 0;
    return {
      action: terminal ? "complete" : "accept", reasonCode: "", reason: "", warnings, baseline, nextPage,
      validationState: warned ? "verified_drift" : terminal ? "exact" : "unverified",
    };
  }

  private cardError(value: PaginationObservation): PaginationWarning | null {
    if (value.rawCardCount !== value.resultCount) return warning("unparsed_product_cards", `${value.rawCardCount - value.resultCount} product cards did not produce valid ASIN records`);
    const size = rangeSize(value);
    if (size !== null && Math.abs(size - value.resultCount) > this.policy.rangeCardTolerance) {
      return warning("result_range_card_mismatch", `Displayed range contains ${size} results but ${value.resultCount} cards were parsed`);
    }
    return null;
  }

  private reprobe(code: string, reason: string, baseline: PaginationBaseline | null): PaginationDecision {
    return { action: "reprobe", reasonCode: code, reason, warnings: [warning(code, reason)], baseline, nextPage: null, validationState: "unverified" };
  }

  private stop(code: string, reason: string, baseline: PaginationBaseline | null): PaginationDecision {
    return { action: "quarantine", reasonCode: code, reason, warnings: [warning(code, reason)], baseline, nextPage: null, validationState: "quarantined" };
  }
}
