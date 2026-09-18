export interface StoreSeed {
  sellerId: string;
  sourceRow: number;
  sourceName: string;
  sourceProfileUrl: string;
  storeUrl: string;
}

export type SourceFormat = "seller_links_de" | "asin_links_b";

export interface SourceProductLink {
  asin: string;
  sourceRow: number;
  productUrl: string;
}

export interface SourceProductTask extends SourceProductLink {
  attempts: number;
}

export interface DetectedSourceColumn {
  header: string;
  column: number;
  columnLetter: string;
}

export interface DetectedSellerSourceLayout {
  sheet: string;
  headerRow: 1;
  sellerName: DetectedSourceColumn;
  sellerProfileUrl: DetectedSourceColumn;
}

export interface SourceStoreStats {
  sourceRows: number;
  duplicateRows: number;
  duplicateSellerIds: number;
  uniqueStores: number;
  appliedLimit: number;
  inputKind?: SourceFormat;
  duplicateAsins?: number;
  uniqueProductAsins?: number;
  detectedLayout?: DetectedSellerSourceLayout;
}

export interface SourceStoreResult {
  seeds: StoreSeed[];
  stats: SourceStoreStats;
  sourceHash: string;
}

export interface SourceProductResult {
  products: SourceProductLink[];
  stats: SourceStoreStats;
  sourceHash: string;
}

export type ProductSellerResult =
  | { kind: "success"; sellerId: string; sellerName: string; sellerProfileUrl: string; httpStatus: number; responseBytes: number; fetchMs: number; error: "" }
  | { kind: "blocked" | "unavailable" | "missing"; sellerId: ""; sellerName: ""; sellerProfileUrl: ""; httpStatus: number; responseBytes: number; fetchMs: number; error: string };

export interface StoreAsinOccurrence {
  sellerId: string;
  asin: string;
  page: number;
  position: number;
  title: string;
  listingProductUrl: string;
  productUrl: string;
  imageUrl: string;
  reviewCount: number | null;
  rating: number | null;
  priceText: string;
  pricePence: number | null;
}

export type PageKind = "success" | "blocked" | "unavailable" | "invalid_structure" | "error";

export type StoreCountWarningCode = "missing_reported_total" | "reported_total_changed" | "count_mismatch";

export interface StoreCountWarning {
  code: StoreCountWarningCode;
  message: string;
  firstObservedPage: number;
}

export interface ReportedTotalObservation {
  page: number;
  reportedTotal: number | null;
}

export interface StoreCompletenessEvidence {
  crawlRound: number;
  structural: boolean;
  exact: boolean;
  reasonCode: string;
  reason: string;
  reportedTotal: number | null;
  reportedTotals: ReportedTotalObservation[];
  warnings: StoreCountWarning[];
  roundPageCount: number;
  roundOccurrenceCount: number;
  roundUniqueAsins: number;
  occurrenceCount: number;
  uniqueAsins: number;
}

export interface StorePageParseResult {
  kind: PageKind;
  error: string;
  occurrences: StoreAsinOccurrence[];
  displayedName: string;
  responseUrl: string;
  responseIdentityError: string;
  nextUrl: string;
  signature: string;
  zeroResults: boolean;
  rawCardCount: number;
  resultRangeStart: number | null;
  resultRangeEnd: number | null;
  resultSummaryText?: string;
  visibleLastPage: number | null;
  httpStatus: number;
  responseBytes: number;
  fetchMs: number;
  reportedTotal: number | null;
  endpointPort: number;
  completenessError: string;
}

export interface StoreRuntimeMetrics {
  browserContexts: number;
  browserPages: number;
  maxObservedConcurrency: number;
  p95FetchMs: number;
  refreshCount: number;
  restartCount: number;
  proxySwitchCount: number;
}

export interface AppConfig {
  projectRoot: string;
  configPath: string;
  configHash: string;
  source: { path: string; sheet: string; limit: number; format: SourceFormat };
  historyFilter: { enabled: boolean };
  amazon: { marketplace: string; site: string; marketplaceId: string; postcode: string; currency: "GBP" };
  browser: {
    headed: boolean;
    executablePath: string;
    controlPath: string;
    navigationTimeoutMs: number;
    requestTimeoutMs: number;
    wafWaitSeconds: number;
    pageRefreshAttempts: number;
    browserRestartAttempts: number;
    noResponseTimeoutMs: number;
    recoveryDelayMs: number;
  };
  stores: {
    concurrency: {
      initial: number;
      min: number;
      max: number;
      successWindowPages: number;
      cooldownMs: number;
    };
    requestsPerSecond: number;
    maxResponseBytes: number;
    maxRetries: number;
    maxBlockedAttempts: number;
    blockedDelayMs: number;
    maxPagesPerStore: number;
    paginationValidation: {
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
    };
    proxyPorts: number[];
  };
  sellerSprite: {
    serviceUrl: string;
    marketplace: string;
    batchSize: number;
    requestTimeoutMs: number;
  };
  filters: {
    maxReviewCount: number;
    minRatingInclusive: number;
    minPricePence: number;
    maxPricePence: number;
    maxVariations: number;
    maxNewAgeDays: number;
    firstChildSalesBandMaxAgeDays: number;
    secondChildSalesBandMaxAgeDays: number;
    maxAgeDays: number;
    firstChildSalesBandMinimum: number;
    secondChildSalesBandMinimum: number;
    thirdChildSalesBandMinimum: number;
    newListingDailySalesMinimum: number;
  };
  output: { root: string };
}

export const STAGES = ["import", "source_resolution", "stores", "prefilter", "history_filter", "enrich", "filter", "sales_7d", "detail", "export"] as const;
export type StageName = (typeof STAGES)[number];
export type StageStatus = "pending" | "running" | "completed" | "partial" | "failed" | "paused";

export type LookupItemStatus = "ok" | "not_found" | "upstream_error";

export interface CompetitorLookupItem {
  asin: string;
  status: LookupItemStatus;
  title: string;
  nodeLabelPath: string;
  brand: string;
  brandUrl: string;
  imageUrl: string;
  bsrRank: number | null;
  childSales30d: number | null;
  availableDate: string;
  fulfillment: string;
  variationCount: number | null;
  buyboxSellerId: string;
  buyboxSellerName: string;
  errorCode: string;
  errorMessage: string;
}

export interface CompetitorLookupResult {
  marketplace: string;
  requested: number;
  succeeded: number;
  missing: number;
  errors: number;
  partial: boolean;
  items: CompetitorLookupItem[];
}

export type DailySalesMinimumResult = "yes" | "No";

export interface Sales7dResult {
  marketplace: string;
  asin: string;
  dataType: "prediction";
  asOfDate: string;
  windowStart: string;
  windowEnd: string;
  dailySalesMinimum: number;
  complete: boolean;
  result: DailySalesMinimumResult;
  days: Array<{ date: string; sales: number | null }>;
}

export interface AsinDetailResult {
  marketplace: string;
  asin: string;
  features: string[] | null;
  overviews: string | null;
}

export interface ExportRow {
  site: string;
  image_url: string;
  asin: string;
  product_url: string;
  store_name: string;
  store_url: string;
  child_sales_30d: number | null;
  daily_sales_3_plus: "yes" | null;
  unit_price_pence: number;
  date_first_available: string;
  review_count: number;
  rating: number;
  fulfillment: string;
  variation_count: number;
  title: string;
  category: string;
  features_json: string | null;
  overviews: string | null;
  brand: string;
  brand_url: string;
}
