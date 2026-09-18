export interface HistoryDatabaseConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  table: string;
  connectTimeoutMs: number;
  readTimeoutMs: number;
  queryBatchSize: number;
}

export const HISTORY_DATABASE_CONFIG: HistoryDatabaseConfig = {
  host: process.env.HISTORY_DB_HOST ?? "",
  port: Number(process.env.HISTORY_DB_PORT ?? 3306),
  database: process.env.HISTORY_DB_NAME ?? "",
  user: process.env.HISTORY_DB_USER ?? "",
  password: process.env.HISTORY_DB_PASSWORD ?? "",
  table: process.env.HISTORY_DB_TABLE ?? "amazon_product_history",
  connectTimeoutMs: 10_000,
  readTimeoutMs: 60_000,
  queryBatchSize: 500,
};
