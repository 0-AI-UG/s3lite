import type { MetadataFilter, FilterValue, FilterOperator } from "./types";

const KNOWN_OPS = new Set(["$eq", "$ne", "$gt", "$gte", "$lt", "$lte", "$in", "$nin"]);

function isFilterOperator(v: unknown): v is FilterOperator {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const keys = Object.keys(v);
  return keys.length > 0 && keys.every(k => KNOWN_OPS.has(k));
}

function evalOperator(value: unknown, op: FilterOperator): boolean {
  if (op.$eq !== undefined && value !== op.$eq) return false;
  if (op.$ne !== undefined && value === op.$ne) return false;
  if (op.$gt !== undefined && (typeof value !== "number" || value <= op.$gt)) return false;
  if (op.$gte !== undefined && (typeof value !== "number" || value < op.$gte)) return false;
  if (op.$lt !== undefined && (typeof value !== "number" || value >= op.$lt)) return false;
  if (op.$lte !== undefined && (typeof value !== "number" || value > op.$lte)) return false;
  if (op.$in !== undefined && !op.$in.includes(value as FilterValue)) return false;
  if (op.$nin !== undefined && op.$nin.includes(value as FilterValue)) return false;
  return true;
}

export function matchesFilter(
  metadata: Record<string, unknown> | undefined,
  filter: MetadataFilter,
): boolean {
  if (!metadata) return false;
  for (const key of Object.keys(filter)) {
    const condition = filter[key];
    const value = metadata[key];
    if (isFilterOperator(condition)) {
      if (!evalOperator(value, condition)) return false;
    } else {
      // bare value = $eq
      if (value !== condition) return false;
    }
  }
  return true;
}
