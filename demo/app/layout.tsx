import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "fina-olap · SSRM demo",
  description: "ag-grid SSRM over DuckDB · fina-olap server + fina-table client",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body style={{ margin: 0, background: "#f6f7f9", color: "#111", fontFamily: "system-ui, sans-serif" }}>
        {children}
      </body>
    </html>
  );
}