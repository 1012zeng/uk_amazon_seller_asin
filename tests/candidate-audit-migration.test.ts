import { describe, expect, it } from "vitest";
import { RunDatabase } from "../../src/database/run-database.js";
import { runFixture, seedCandidates } from "./helpers.js";

describe("schema v14 run boundary", () => {
  it("does not migrate or resume a schema v13 run, but preserves read-only audit access", () => {
    const { store } = runFixture();
    const [asin] = seedCandidates(store, 1);
    const runDir = store.runDir;
    store.db.pragma("user_version = 13");
    store.close();

    expect(() => new RunDatabase(runDir)).toThrow(/schema 13 is incompatible.*create a new run/i);
    const readonly = new RunDatabase(runDir, { readonly: true });
    expect(readonly.schemaVersion).toBe(13);
    expect(readonly.connection.prepare("SELECT asin FROM asin_candidates_audit WHERE asin=?").get(asin)).toEqual({ asin });
    expect(readonly.integrityCheck()).toBe("ok");
    expect(readonly.connection.pragma("foreign_key_check")).toEqual([]);
    readonly.close();
  });
});
