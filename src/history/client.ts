import { createConnection, type ConnectionOptions } from "mysql2/promise";
import { HISTORY_DATABASE_CONFIG, type HistoryDatabaseConfig } from "./config.js";

interface HistoryDatabaseConnection {
  query(sql: string): Promise<unknown>;
  execute(options: { sql: string; values: string[]; timeout: number }): Promise<readonly [unknown, unknown]>;
  end(): Promise<void>;
}

type HistoryDatabaseConnector = (options: ConnectionOptions) => Promise<HistoryDatabaseConnection>;

export interface HistoryAsinLookup {
  findExistingAsins(asins: readonly string[]): Promise<Set<string>>;
}

export class HistoryDatabaseClient implements HistoryAsinLookup {
  constructor(
    private readonly config: HistoryDatabaseConfig = HISTORY_DATABASE_CONFIG,
    private readonly options: {
      connect?: HistoryDatabaseConnector;
    } = {},
  ) {}

  async findExistingAsins(asins: readonly string[]): Promise<Set<string>> {
    const candidates = [...new Set(asins.map((asin) => asin.trim().toUpperCase()).filter(Boolean))];
    if (candidates.length === 0) return new Set();

    if (!this.config.password) throw new Error("History database password is missing");
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(this.config.table)) throw new Error("History database table name is invalid");

    const connect = this.options.connect ?? (async (connectionOptions) => await createConnection(connectionOptions) as unknown as HistoryDatabaseConnection);
    const connection = await connect({
      host: this.config.host,
      port: this.config.port,
      database: this.config.database,
      user: this.config.user,
      password: this.config.password,
      charset: "utf8mb4",
      connectTimeout: this.config.connectTimeoutMs,
      multipleStatements: false,
    });
    let transactionStarted = false;
    const matches = new Set<string>();
    try {
      await connection.query("START TRANSACTION READ ONLY");
      transactionStarted = true;
      for (let offset = 0; offset < candidates.length; offset += this.config.queryBatchSize) {
        const batch = candidates.slice(offset, offset + this.config.queryBatchSize);
        const placeholders = batch.map(() => "?").join(",");
        const [rows] = await connection.execute({
          sql: `SELECT DISTINCT asin FROM \`${this.config.table}\` WHERE asin IN (${placeholders})`,
          values: batch,
          timeout: this.config.readTimeoutMs,
        });
        if (!Array.isArray(rows)) throw new Error("History database returned an invalid ASIN result set");
        for (const row of rows) {
          if (!row || typeof row !== "object" || !("asin" in row)) throw new Error("History database returned an invalid ASIN row");
          const asin = String((row as { asin: unknown }).asin ?? "").trim().toUpperCase();
          if (asin) matches.add(asin);
        }
      }
      return matches;
    } finally {
      if (transactionStarted) {
        try { await connection.query("ROLLBACK"); } catch { /* Preserve the original query error. */ }
      }
      await connection.end();
    }
  }
}
