import type Database from "better-sqlite3";
import type { Sales7dResult } from "../../shared/types.js";
import { ExportRepository } from "./export-repository.js";

function nowIso(): string { return new Date().toISOString(); }

export class SalesRepository {
  constructor(private readonly db: Database.Database, private readonly exports: ExportRepository) {}

  materialize(asOfDate: string, windowStart: string, windowEnd: string, dailySalesMinimum: number): void {
    if (!Number.isSafeInteger(dailySalesMinimum) || dailySalesMinimum < 1) throw new Error("Sales-7d daily minimum must be a positive integer");
    const now = nowIso();
    this.db.transaction(() => {
      this.db.prepare(`INSERT OR IGNORE INTO sales_7d_tasks(asin,as_of_date,window_start,window_end,daily_sales_minimum,created_at,updated_at)
        SELECT asin,?,?,?,?,?,? FROM asin_candidates WHERE state='sales_pending' ORDER BY asin`).run(asOfDate, windowStart, windowEnd, dailySalesMinimum, now, now);
      const mismatch = this.db.prepare(`SELECT asin FROM sales_7d_tasks
        WHERE as_of_date<>? OR window_start<>? OR window_end<>? OR daily_sales_minimum<>? ORDER BY asin LIMIT 1`)
        .get(asOfDate, windowStart, windowEnd, dailySalesMinimum) as { asin: string } | undefined;
      if (mismatch) throw new Error(`Sales-7d task contract does not match the current run: ${mismatch.asin}`);
      this.db.prepare("UPDATE asin_candidates SET sales_7d_state='pending',sales_7d_daily_minimum=?,sales_window_start=?,sales_window_end=?,sales_7d_result=NULL,sales_7d_complete=NULL,sales_7d_days_json=NULL,daily_sales_3_plus=NULL,updated_at=? WHERE state='sales_pending'")
        .run(dailySalesMinimum, windowStart, windowEnd, now);
    })();
  }

  hasWork(): boolean { return Boolean(this.db.prepare("SELECT 1 FROM sales_7d_tasks WHERE state IN ('pending','running','failed') LIMIT 1").get()); }

  next(): { asin: string; dailySalesMinimum: number } | null {
    const row = this.db.prepare(`SELECT asin,daily_sales_minimum dailySalesMinimum FROM sales_7d_tasks
      WHERE state IN ('pending','failed','running') ORDER BY asin LIMIT 1`).get() as { asin: string; dailySalesMinimum: number } | undefined;
    if (!row) return null;
    const now = nowIso();
    this.db.transaction(() => {
      this.db.prepare("UPDATE sales_7d_tasks SET state='running',attempt_count=attempt_count+1,last_error='',updated_at=? WHERE asin=?").run(now, row.asin);
      this.db.prepare("UPDATE asin_candidates SET sales_7d_state='running',updated_at=? WHERE asin=?").run(now, row.asin);
    })();
    return row;
  }

  fail(asin: string, error: unknown): void {
    const message = (error instanceof Error ? error.message : String(error ?? "")).slice(0, 4_000);
    const now = nowIso();
    this.db.transaction(() => {
      this.db.prepare("UPDATE sales_7d_tasks SET state='failed',last_error=?,updated_at=? WHERE asin=?").run(message, now, asin);
      this.db.prepare("UPDATE asin_candidates SET sales_7d_state='failed',updated_at=? WHERE asin=?").run(now, asin);
    })();
  }

  complete(asin: string, result: Sales7dResult): "retained" | "filtered_no" {
    return this.db.transaction(() => {
      const now = nowIso();
      const task = this.db.prepare("SELECT daily_sales_minimum dailySalesMinimum FROM sales_7d_tasks WHERE asin=?").get(asin) as { dailySalesMinimum: number } | undefined;
      if (!task || task.dailySalesMinimum !== result.dailySalesMinimum) throw new Error("Sales-7d result used a different daily minimum than the persisted task");
      const state = result.result === "yes" ? "retained" : "filtered_no";
      const reason = state === "retained" ? "" : "daily_sales_minimum_no";
      const daysJson = JSON.stringify(result.days);
      this.db.prepare("UPDATE sales_7d_tasks SET state=?,result=?,days_json=?,filter_reason=?,last_error='',completed_at=?,updated_at=? WHERE asin=?")
        .run(state, result.result, daysJson, reason, now, now, asin);
      this.db.prepare("UPDATE asin_candidates SET sales_7d_state=?,sales_7d_result=?,sales_7d_complete=?,sales_window_start=?,sales_window_end=?,sales_7d_days_json=?,daily_sales_3_plus=?,updated_at=? WHERE asin=?")
        .run(state, result.result, result.complete ? 1 : 0, result.windowStart, result.windowEnd, daysJson, state === "retained" ? "yes" : null, now, asin);
      if (state === "retained") {
        this.exports.setDailySales3Plus(asin);
        this.db.prepare("UPDATE asin_candidates SET state='retained',filter_stage='',filter_reason='',updated_at=? WHERE asin=?").run(now, asin);
      } else {
        this.exports.remove(asin);
        this.db.prepare("UPDATE asin_candidates SET state='filtered_sales',filter_stage='sales_7d',filter_reason=?,updated_at=? WHERE asin=?").run(reason, now, asin);
      }
      return state;
    })();
  }

  isTerminal(): boolean { return !(this.db.prepare("SELECT 1 FROM sales_7d_tasks WHERE state IN ('pending','running','failed') LIMIT 1").get()); }
  counts(): Record<string, number> {
    const rows = this.db.prepare("SELECT state,COUNT(*) count FROM sales_7d_tasks GROUP BY state ORDER BY state").all() as Array<{ state: string; count: number }>;
    return Object.fromEntries(rows.map((row) => [row.state, row.count]));
  }

  thresholdCounts(): Record<string, number> {
    const rows = this.db.prepare("SELECT daily_sales_minimum threshold,COUNT(*) count FROM sales_7d_tasks GROUP BY daily_sales_minimum ORDER BY daily_sales_minimum").all() as Array<{ threshold: number; count: number }>;
    return Object.fromEntries(rows.map((row) => [String(row.threshold), row.count]));
  }
}
