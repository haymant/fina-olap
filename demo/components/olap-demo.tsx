"use client";

import { useEffect, useState } from "react";

import { FinaTable, type FieldDefinition } from "fina-table";

const FIELDS: FieldDefinition[] = [
  { field: "portfolio", label: "Portfolio" },
  { field: "instrument", label: "Instrument" },
  { field: "leg", label: "Leg" },
  { field: "strategy", label: "Strategy" },
  { field: "paymentCcy", label: "Payment CCY" },
  { field: "lastFixingDate", label: "Last Fixing", kind: "date" },
  { field: "delta", label: "Delta", kind: "number" },
  { field: "gamma", label: "Gamma", kind: "number" },
  { field: "vega", label: "Vega", kind: "number" },
  { field: "qty", label: "Qty", kind: "number" },
  { field: "notional", label: "Notional", kind: "number" },
];

export function OlapDemo() {
  const [health, setHealth] = useState<string>("…");

  useEffect(() => {
    fetch("/api/health")
      .then((r) => r.json())
      .then((j) => setHealth(`${j.fixture?.rows ?? "?"} rows @ ${j.fixture?.path ?? "?"}`))
      .catch(() => setHealth("api offline — run `npm run dev`"));
  }, []);

  return (
    <div>
      <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 8 }}>api: {health}</div>
      <FinaTable fields={FIELDS} tableName="trades" pageSize={50} height="62vh" />
    </div>
  );
}