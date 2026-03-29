import type { MetadataFilter, FilterValue, FilterOperator } from "./types";

function isFilterOperator(v: unknown): v is FilterOperator {
  return typeof v === "object" && v !== null && !Array.isArray(v);
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
