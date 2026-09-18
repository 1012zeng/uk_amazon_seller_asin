import { describe, expect, it } from "vitest";
import { HistoryDatabaseClient } from "../../src/history/client.js";
import type { HistoryDatabaseConfig } from "../../src/history/config.js";
import { runFixture } from "./helpers.js";

const TEST_CONFIG: HistoryDatabaseConfig = {
  host: "127.0.0.1",
  port: 3306,
  database: "product_selection_system",
  user: "test",
  password: "test-secret",
  table: "amazon_product_history",
  connectTimeoutMs: 1_000,
  readTimeoutMs: 1_000,
  queryBatchSize: 2,
};

describe("history database client", () => {
  it("uses batched indexed reads inside a read-only transaction and rolls it back", async () => {
    const { store } = runFixture();
    store.close();
    const statements: string[] = [];
    const batches: string[][] = [];
    let ended = false;
    const client = new HistoryDatabaseClient(TEST_CONFIG, {
      connect: async (options) => {
        expect(options).toMatchObject({ password: "test-secret", multipleStatements: false });
        return {
          query: async (sql) => { statements.push(sql); },
          execute: async ({ sql, values }) => {
            expect(sql).toMatch(/^SELECT DISTINCT asin FROM `amazon_product_history` WHERE asin IN \(/);
            batches.push(values);
            return [[{ asin: values[0]!.toLowerCase() }], []];
          },
          end: async () => { ended = true; },
        };
      },
    });
    await expect(client.findExistingAsins(["B000000001", "B000000002", "B000000003"])).resolves.toEqual(new Set(["B000000001", "B000000003"]));
    expect(batches).toEqual([["B000000001", "B000000002"], ["B000000003"]]);
    expect(statements).toEqual(["START TRANSACTION READ ONLY", "ROLLBACK"]);
    expect(ended).toBe(true);
  });

  it("fails before connecting when the hardcoded password is absent", async () => {
    const { store } = runFixture();
    store.close();
    await expect(new HistoryDatabaseClient({ ...TEST_CONFIG, password: "" }).findExistingAsins(["B000000001"])).rejects.toThrow(/password is missing/i);
  });
});
