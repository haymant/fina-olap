import type { DataSourceRef, SSRMRequest, SSRMResponse } from "./types";

export interface FetchOptions {
  /** Explicit endpoint; otherwise the demo rewrite `/api/olap` is used. */
  endpoint?: string;
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

/** A parquet table discovered under a bucket/prefix by `/api/listTables`. */
export interface ListedTable {
  label: string;
  tableName: string;
  uri: string;
}

/**
 * POSTs an SSRM request to the fina-olap HTTP API. The server performs the
 * page block (LIMIT s+1) and returns `lastRow === -1` while more data exists.
 */
export async function fetchRows(
  request: SSRMRequest,
  options: FetchOptions = {},
): Promise<SSRMResponse> {
  const endpoint = options.endpoint ?? "/api/getRows";
  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", ...options.headers },
      body: JSON.stringify(request),
      signal: options.signal,
    });
  } catch (err) {
    throw new Error(`fina-olap request failed (network): ${(err as Error).message}`);
  }
  if (!res.ok) {
    throw new Error(`fina-olap request failed (${res.status}): ${await safeText(res)}`);
  }
  const payload = (await res.json()) as SSRMResponse;
  if (!payload || payload.success === false) {
    throw new Error(payload?.error ?? "fina-olap returned an unsuccessful response");
  }
  return payload;
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 300);
  } catch {
    return "";
  }
}

/** POST a dataSource to `/api/listTables` and return candidate tables. */
export async function listTables(
  dataSource: DataSourceRef,
  options: FetchOptions = {},
): Promise<ListedTable[]> {
  const endpoint = options.endpoint ? options.endpoint.replace(/getRows.*$/, "listTables") : "/api/listTables";
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", ...options.headers },
    body: JSON.stringify({ dataSource }),
    signal: options.signal,
  });
  if (!res.ok) throw new Error(`listTables failed (${res.status}): ${await safeText(res)}`);
  const payload = (await res.json()) as { ok?: boolean; error?: string; tables?: ListedTable[] };
  if (payload?.ok === false) throw new Error(payload.error ?? "listTables failed");
  return payload.tables ?? [];
}