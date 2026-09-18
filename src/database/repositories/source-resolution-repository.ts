import type Database from "better-sqlite3";
import type { AppConfig, ProductSellerResult, SourceProductLink, SourceProductTask } from "../../shared/types.js";
import { canonicalStoreUrl } from "../../input/source-stores.js";

function nowIso(): string { return new Date().toISOString(); }

export class SourceResolutionRepository {
  constructor(private readonly db: Database.Database, private readonly getConfig: () => AppConfig) {}

  seed(products: SourceProductLink[], createdAt = nowIso()): void {
    const insert = this.db.prepare("INSERT INTO source_product_links(asin,source_row,product_url,created_at,updated_at) VALUES(?,?,?,?,?)");
    for (const product of products) insert.run(product.asin, product.sourceRow, product.productUrl, createdAt, createdAt);
  }

  pending(limit = 1): SourceProductTask[] {
    return this.db.prepare("SELECT asin,source_row sourceRow,product_url productUrl,attempts FROM source_product_links WHERE state IN ('pending','retry') ORDER BY source_row,asin LIMIT ?")
      .all(limit) as SourceProductTask[];
  }

  isTerminal(): boolean {
    return !this.db.prepare("SELECT 1 FROM source_product_links WHERE state IN ('pending','retry') LIMIT 1").get();
  }

  applyResolved(task: SourceProductTask, result: Extract<ProductSellerResult, { kind: "success" }>): { insertedStore: boolean } {
    const config = this.getConfig();
    const now = nowIso();
    return this.db.transaction(() => {
      const current = this.db.prepare("SELECT state FROM source_product_links WHERE asin=?").get(task.asin) as { state: string } | undefined;
      if (!current || !["pending", "retry"].includes(current.state)) return { insertedStore: false };
      this.db.prepare("UPDATE source_product_links SET state='resolved',attempts=attempts+1,seller_id=?,seller_name=?,seller_profile_url=?,last_error='',completed_at=?,updated_at=? WHERE asin=?")
        .run(result.sellerId, result.sellerName, result.sellerProfileUrl, now, now, task.asin);
      const inserted = this.db.prepare(`INSERT OR IGNORE INTO source_stores(seller_id,source_row,source_name,source_profile_url,store_url,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?)`).run(
        result.sellerId,
        task.sourceRow,
        result.sellerName,
        result.sellerProfileUrl,
        canonicalStoreUrl(config.amazon.marketplace, config.amazon.marketplaceId, result.sellerId),
        now,
        now,
      );
      if (inserted.changes > 0) {
        const storeUrl = canonicalStoreUrl(config.amazon.marketplace, config.amazon.marketplaceId, result.sellerId);
        this.db.prepare("INSERT INTO store_pages(seller_id,crawl_round,page,url,created_at,updated_at) VALUES(?,1,1,?,?,?)")
          .run(result.sellerId, storeUrl, now, now);
      }
      return { insertedStore: inserted.changes > 0 };
    })();
  }

  applyFailure(task: SourceProductTask, error: string): { state: "retry" | "failed"; attempts: number } {
    const maxAttempts = this.getConfig().stores.maxRetries;
    const now = nowIso();
    return this.db.transaction(() => {
      const row = this.db.prepare("SELECT state,attempts FROM source_product_links WHERE asin=?").get(task.asin) as { state: string; attempts: number } | undefined;
      if (!row || !["pending", "retry"].includes(row.state)) return { state: "failed" as const, attempts: row?.attempts ?? task.attempts };
      const attempts = row.attempts + 1;
      const state: "failed" | "retry" = attempts >= maxAttempts ? "failed" : "retry";
      this.db.prepare("UPDATE source_product_links SET state=?,attempts=?,last_error=?,completed_at=?,updated_at=? WHERE asin=?")
        .run(state, attempts, error.slice(0, 4_000), state === "failed" ? now : "", now, task.asin);
      return { state, attempts };
    })();
  }

  counts(): Record<string, number> {
    const rows = this.db.prepare("SELECT state,COUNT(*) count FROM source_product_links GROUP BY state ORDER BY state").all() as Array<{ state: string; count: number }>;
    return Object.fromEntries(rows.map((row) => [row.state, row.count]));
  }

  failedCount(): number {
    return (this.db.prepare("SELECT COUNT(*) count FROM source_product_links WHERE state='failed'").get() as { count: number }).count;
  }

  resolvedProductCount(): number {
    return (this.db.prepare("SELECT COUNT(*) count FROM source_product_links WHERE state='resolved'").get() as { count: number }).count;
  }

  uniqueStoreCount(): number {
    return (this.db.prepare("SELECT COUNT(*) count FROM source_stores").get() as { count: number }).count;
  }
}
