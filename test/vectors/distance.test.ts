import { expect, test, describe } from "bun:test";
import { cosineDistance, euclideanDistance, dotProductDistance, computeNorm } from "../../src/vectors/distance";

describe("computeNorm", () => {
  test("unit vector", () => {
    expect(computeNorm(new Float32Array([1, 0, 0]))).toBeCloseTo(1);
  });

  test("known vector", () => {
    expect(computeNorm(new Float32Array([3, 4]))).toBeCloseTo(5);
  });

  test("zero vector", () => {
    expect(computeNorm(new Float32Array([0, 0, 0]))).toBe(0);
  });
});

describe("cosineDistance", () => {
  test("identical vectors → 0", () => {
    const v = new Float32Array([1, 2, 3]);
    expect(cosineDistance(v, v)).toBeCloseTo(0);
  });

  test("opposite vectors → 2", () => {
    const a = new Float32Array([1, 0, 0]);
    const b = new Float32Array([-1, 0, 0]);
    expect(cosineDistance(a, b)).toBeCloseTo(2);
  });

  test("orthogonal vectors → 1", () => {
    const a = new Float32Array([1, 0]);
    const b = new Float32Array([0, 1]);
    expect(cosineDistance(a, b)).toBeCloseTo(1);
  });

  test("with pre-computed norms", () => {
    const a = new Float32Array([3, 4]);
    const b = new Float32Array([4, 3]);
    const dist = cosineDistance(a, b, 5, 5);
    expect(dist).toBeCloseTo(1 - 24 / 25);
  });

  test("zero vector returns 1", () => {
    const a = new Float32Array([0, 0]);
    const b = new Float32Array([1, 2]);
    expect(cosineDistance(a, b)).toBe(1);
  });
});

describe("euclideanDistance", () => {
  test("identical vectors → 0", () => {
    const v = new Float32Array([1, 2, 3]);
    expect(euclideanDistance(v, v)).toBe(0);
  });

  test("known distance", () => {
    const a = new Float32Array([0, 0]);
    const b = new Float32Array([3, 4]);
    expect(euclideanDistance(a, b)).toBeCloseTo(5);
  });

  test("unit distance", () => {
    const a = new Float32Array([0]);
    const b = new Float32Array([1]);
    expect(euclideanDistance(a, b)).toBeCloseTo(1);
  });
});

describe("dotProductDistance", () => {
  test("identical unit vectors → -1", () => {
    const v = new Float32Array([1, 0, 0]);
    expect(dotProductDistance(v, v)).toBeCloseTo(-1);
  });

  test("orthogonal vectors → 0", () => {
    const a = new Float32Array([1, 0]);
    const b = new Float32Array([0, 1]);
    expect(dotProductDistance(a, b)).toBeCloseTo(0);
  });

  test("known dot product", () => {
    const a = new Float32Array([2, 3]);
    const b = new Float32Array([4, 5]);
    // dot = 8 + 15 = 23, negated = -23
    expect(dotProductDistance(a, b)).toBeCloseTo(-23);
  });
});
