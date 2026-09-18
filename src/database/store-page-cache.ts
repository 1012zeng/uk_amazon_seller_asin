import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { StoreAsinOccurrence, StorePageParseResult } from "../shared/types.js";

interface CachedPage {
  sellerId: string;
  page: number;
  capturedAt: string;
  result: StorePageParseResult;
}

// Page evidence is durable before its ledger row is committed. ASIN rows are
// inserted only after all planned pages terminate, so resume needs this cache.
export class StorePageCache {
  constructor(private readonly runDir: string) {}

  private filename(sellerId: string, page: number): string {
    if (!/^[A-Z0-9]{10,20}$/.test(sellerId) || !Number.isSafeInteger(page) || page < 1) throw new Error("Invalid store page cache identity");
    return path.join(this.runDir, "store-page-cache", sellerId, `${page}.json`);
  }

  write(sellerId: string, page: number, result: StorePageParseResult, capturedAt: string): string {
    this.assertOccurrences(sellerId, page, result.occurrences);
    const file = this.filename(sellerId, page);
    mkdirSync(path.dirname(file), { recursive: true });
    const payload = JSON.stringify({ sellerId, page, capturedAt, result } satisfies CachedPage);
    const temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(temporary, payload, "utf8");
    renameSync(temporary, file);
    return createHash("sha256").update(payload).digest("hex");
  }

  read(sellerId: string, page: number, expectedHash: string): CachedPage {
    const payload = readFileSync(this.filename(sellerId, page), "utf8");
    if (!expectedHash || createHash("sha256").update(payload).digest("hex") !== expectedHash) throw new Error(`Store page cache checksum mismatch: ${sellerId} page ${page}`);
    const cached = JSON.parse(payload) as CachedPage;
    if (cached.sellerId !== sellerId || cached.page !== page || !Array.isArray(cached.result?.occurrences)) throw new Error("Store page cache identity mismatch");
    this.assertOccurrences(sellerId, page, cached.result.occurrences);
    return cached;
  }

  private assertOccurrences(sellerId: string, page: number, rows: StoreAsinOccurrence[]): void {
    if (rows.some((item) => item.sellerId !== sellerId || item.page !== page || !/^[A-Z0-9]{10}$/.test(item.asin))) throw new Error("Store occurrence identity mismatch");
  }
}
