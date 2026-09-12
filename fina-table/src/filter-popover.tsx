import { useEffect, useRef, useState } from "react";

import type { FilterCondition, FilterConditionType } from "./types";
import { FilterIcon } from "./icons";

const TEXT_OPS = ["contains", "notContains", "startsWith", "endsWith", "equals", "notEquals"];
const NUMBER_OPS = ["equals", "notEquals", "lessThan", "lessThanOrEqual", "greaterThan", "greaterThanOrEqual", "inRange"];
const DATE_OPS = ["equals", "before", "after", "between", "notEquals"];
const BOOL_OPS = ["equals", "notEquals"];

export interface FilterPopoverProps {
  field: string;
  label: string;
  kind?: "string" | "number" | "date" | "datetime" | "boolean";
  condition: FilterCondition | null;
  onApply: (condition: FilterCondition) => void;
  onClear: () => void;
}

/** Self-contained header filter (hover/focus to reveal, click to open). */
export function FilterPopover({ field, label, kind = "string", condition, onApply, onClear }: FilterPopoverProps) {
  const [open, setOpen] = useState(false);
  const [filterType, setFilterType] = useState<FilterConditionType>(toType(kind));
  const [operator, setOperator] = useState(condition?.operator ?? defaultOp(kind));
  const [filter, setFilter] = useState(toString(condition?.filter));
  const [filterTo, setFilterTo] = useState(toString(condition?.filterTo));
  const [boolVal, setBoolVal] = useState(condition?.filter === false ? "false" : "true");
  const rootRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: Event) => {
      const t = e.target as Node;
      if (rootRef.current && !rootRef.current.contains(t)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const ops =
    kind === "number"
      ? NUMBER_OPS
      : kind === "date" || kind === "datetime"
        ? DATE_OPS
        : kind === "boolean"
          ? BOOL_OPS
          : TEXT_OPS;
  const isRange = operator === "inRange" || operator === "between";
  const active = condition != null;

  const apply = (e: { preventDefault: () => void }) => {
    e.preventDefault();
    const cond: FilterCondition = { filterType, operator };
    if (kind === "boolean") {
      cond.filter = boolVal === "true";
    } else if (isRange) {
      cond.filter = parseValue(filter);
      cond.filterTo = parseValue(filterTo);
    } else {
      cond.filter = kind === "number" ? (filter === "" ? undefined : Number(filter) || 0) : filter;
    }
    onApply(cond);
    setOpen(false);
  };

  return (
    <span
      className="ft-popover-trigger"
      ref={rootRef}
      data-testid={`filter-trigger-${field}`}
      onClick={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        className="ft-th-filter"
        data-active={active}
        aria-label={`Filter ${label}`}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
      >
        <FilterIcon />
      </button>
      {open && (
        <form className="ft-menu ft-filter-menu" style={{ top: "calc(100% + 4px)", left: 0 }} onSubmit={apply}>
          <div className="ft-field-row">
            <select
              className="ft-select"
              aria-label={`${label} operator`}
              value={operator}
              onChange={(e) => setOperator(e.target.value)}
            >
              {ops.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
          </div>
          {kind === "boolean" ? (
            <div className="ft-field-row">
              <select className="ft-select" value={boolVal} onChange={(e) => setBoolVal(e.target.value)}>
                <option value="true">true</option>
                <option value="false">false</option>
              </select>
            </div>
          ) : (
            <>
              <div className="ft-field-row">
                <input
                  className="ft-input"
                  style={{ flex: 1 }}
                  aria-label={`${label} filter value`}
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                />
              </div>
              {isRange && (
                <div className="ft-field-row">
                  <input
                    className="ft-input"
                    style={{ flex: 1 }}
                    aria-label={`${label} filter to`}
                    value={filterTo}
                    onChange={(e) => setFilterTo(e.target.value)}
                  />
                </div>
              )}
            </>
          )}
          <div className="ft-field-row" style={{ justifyContent: "flex-end", margin: 0 }}>
            <button type="button" className="ft-icon-btn" onClick={() => { onClear(); setOpen(false); }}>
              Clear
            </button>
            <button type="submit" className="ft-icon-btn" data-active="true">
              Apply
            </button>
          </div>
        </form>
      )}
    </span>
  );
}

function toType(kind?: FilterPopoverProps["kind"]): FilterConditionType {
  if (kind === "number") return "number";
  if (kind === "date" || kind === "datetime") return "date";
  if (kind === "boolean") return "boolean";
  return "text";
}

function defaultOp(kind?: FilterPopoverProps["kind"]): string {
  if (kind === "number") return "greaterThan";
  if (kind === "date" || kind === "datetime") return "after";
  if (kind === "boolean") return "equals";
  return "contains";
}

function toString(v: FilterCondition["filter"] | FilterCondition["filterTo"]): string {
  return v == null ? "" : String(v);
}

function parseValue(v: string): string | number {
  const n = Number(v);
  return v.trim() !== "" && !Number.isNaN(n) ? n : v;
}