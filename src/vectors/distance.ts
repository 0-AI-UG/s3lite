import type { DistanceMetric } from "./types";

export function computeNorm(v: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < v.length; i++) {
    sum += v[i]! * v[i]!;
  }
  return Math.sqrt(sum);
}

export function cosineDistance(a: Float32Array, b: Float32Array, normA?: number, normB?: number): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
  }
  const na = normA ?? computeNorm(a);
  const nb = normB ?? computeNorm(b);
  if (na === 0 || nb === 0) return 1;
  return 1 - dot / (na * nb);
}

export function euclideanDistance(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i]! - b[i]!;
    sum += d * d;
  }
  return Math.sqrt(sum);
}

export function dotProductDistance(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) {
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
