import { describe, expect, it, vi } from "vitest";
import { pipelineCommand, type PipelineCommands } from "../../src/pipeline.js";

function commands(codes: Partial<Record<Exclude<keyof PipelineCommands, "initialize">, number>> = {}): PipelineCommands {
  return {
    initialize: vi.fn(async () => "run"), sourceResolution: vi.fn(async () => codes.sourceResolution ?? 0), stores: vi.fn(async () => codes.stores ?? 0), prefilter: vi.fn(async () => codes.prefilter ?? 0),
    historyFilter: vi.fn(async () => codes.historyFilter ?? 0), enrich: vi.fn(async () => codes.enrich ?? 0), filter: vi.fn(async () => codes.filter ?? 0), sales7d: vi.fn(async () => codes.sales7d ?? 0), detail: vi.fn(async () => codes.detail ?? 0), export: vi.fn(async () => codes.export ?? 0),
  };
}

describe("pipeline", () => {
  it("runs every new stage", async () => expect(await pipelineCommand({}, commands())).toBe(0));
  it("continues after partial source resolution and returns exit code 2", async () => expect(await pipelineCommand({}, commands({ sourceResolution: 3 }))).toBe(2));
  it("stops before stores when source resolution pauses", async () => {
    const api = commands({ sourceResolution: 2 });
    expect(await pipelineCommand({}, api)).toBe(2);
    expect(api.stores).not.toHaveBeenCalled();
  });
  it("continues after a partial store snapshot and returns exit code 2", async () => expect(await pipelineCommand({}, commands({ stores: 2, export: 2 }))).toBe(2));
  it("stops when MCP enrichment pauses", async () => {
    const api = commands({ enrich: 2 });
    expect(await pipelineCommand({}, api)).toBe(2);
    expect(api.filter).not.toHaveBeenCalled();
  });
  it("stops before MCP when history filtering pauses", async () => {
    const api = commands({ historyFilter: 2 });
    expect(await pipelineCommand({}, api)).toBe(2);
    expect(api.enrich).not.toHaveBeenCalled();
  });
  it("stops before export when ASIN detail pauses", async () => {
    const api = commands({ detail: 2 });
    expect(await pipelineCommand({}, api)).toBe(2);
    expect(api.export).not.toHaveBeenCalled();
  });
});
