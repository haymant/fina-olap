import { OlapDemo } from "@/components/olap-demo";

export default function HomePage() {
  return (
    <main style={{ maxWidth: 1400, margin: "0 auto", padding: "1.5rem" }}>
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 16 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 20 }}>fina-olap · SSRM OLAP demo</h1>
          <p style={{ margin: "4px 0 0", opacity: 0.7, fontSize: 13 }}>
            DuckDB compiles Server-Side Row Model payloads over a generated parquet fixture.
            Group, add measures, pivot and LOD-join — all server-side.
          </p>
        </div>
      </header>
      <div style={{ marginTop: "1rem" }}>
        <OlapDemo />
      </div>
    </main>
  );
}