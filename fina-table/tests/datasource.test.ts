import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchRows } from "../src/datasource";
import type { SSRMRequest, SSRMResponse } from "../src/types";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchRows", () => {
  const req: SSRMRequest = { startRow: 0, endRow: 10, rowGroupCols: [], groupKeys: [] };

  it("posts JSON to the endpoint and returns the payload", async () => {
    const payload: SSRMResponse = {
      success: true,
      rows: [{ portfolio: "P1", delta: 1.5 }],
      lastRow: 0,
    };
    const mock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) =>
      new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } }),
    );
    vi.stubGlobal("fetch", mock);

    const out = await fetchRows(req, { endpoint: "/api/olap" });
    expect(mock).toHaveBeenCalledWith("/api/olap", expect.objectContaining({ method: "POST" }));
    const body = JSON.parse((mock.mock.calls[0]?.[1]?.body as string) ?? "{}") as SSRMRequest;
    expect(body.startRow).toBe(0);
    expect(out.rows[0]).toEqual({ portfolio: "P1", delta: 1.5 });
  });

  it("throws on non-OK HTTP and on unsuccessful payloads", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 500 })));
    await expect(fetchRows(req)).rejects.toThrow(/500/);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ success: false, rows: [], lastRow: -1, error: "nope" }), { status: 200 })),
    );
    await expect(fetchRows(req)).rejects.toThrow(/nope/);
  });

  it("surfaces network failures with a readable message", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error("socket hang up"))));
    await expect(fetchRows(req)).rejects.toThrow(/network/);
  });
});