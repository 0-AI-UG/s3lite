import type { DistanceMetric } from "./types";

export function computeNorm(v: Float32Array): number {
  const len = v.length;
  let sum = 0;
  let i = 0;
  const end4 = len & ~3;
  for (; i < end4; i += 4) {
    const a = v[i]!, b = v[i + 1]!, c = v[i + 2]!, d = v[i + 3]!;
    sum += a * a + b * b + c * c + d * d;
  }
  for (; i < len; i++) {
    const x = v[i]!;
    sum += x * x;
  }
  return Math.sqrt(sum);
}

export function cosineDistance(a: Float32Array, b: Float32Array, normA?: number, normB?: number): number {
  const len = a.length;
  let dot = 0;
  let i = 0;
  const end4 = len & ~3;
  for (; i < end4; i += 4) {
    dot += a[i]! * b[i]! + a[i + 1]! * b[i + 1]! + a[i + 2]! * b[i + 2]! + a[i + 3]! * b[i + 3]!;
  }
  for (; i < len; i++) {
    dot += a[i]! * b[i]!;
  }
  const na = normA ?? computeNorm(a);
  const nb = normB ?? computeNorm(b);
  if (na === 0 || nb === 0) return 1;
  return 1 - dot / (na * nb);
}

export function euclideanDistance(a: Float32Array, b: Float32Array): number {
  const len = a.length;
  let sum = 0;
  let i = 0;
  const end4 = len & ~3;
  for (; i < end4; i += 4) {
    const d0 = a[i]! - b[i]!, d1 = a[i + 1]! - b[i + 1]!;
    const d2 = a[i + 2]! - b[i + 2]!, d3 = a[i + 3]! - b[i + 3]!;
    sum += d0 * d0 + d1 * d1 + d2 * d2 + d3 * d3;
  }
  for (; i < len; i++) {
    const d = a[i]! - b[i]!;
    sum += d * d;
  }
  return Math.sqrt(sum);
}

export function dotProductDistance(a: Float32Array, b: Float32Array): number {
  const len = a.length;
  let dot = 0;
  let i = 0;
  const end4 = len & ~3;
  for (; i < end4; i += 4) {
    dot += a[i]! * b[i]! + a[i + 1]! * b[i + 1]! + a[i + 2]! * b[i + 2]! + a[i + 3]! * b[i + 3]!;
  }
  for (; i < len; i++) {
    dot += a[i]! * b[i]!;
  }
  return -dot; // negated so lower = more similar
}

export function getDistanceFn(metric: DistanceMetric): (a: Float32Array, b: Float32Array, normA?: number, normB?: number) => number {
  switch (metric) {
    case "cosine": return cosineDistance;
    case "euclidean": return euclideanDistance;
    case "dotproduct": return dotProductDistance;
  }
}
