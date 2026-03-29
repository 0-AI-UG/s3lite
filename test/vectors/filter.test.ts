import { expect, test, describe } from "bun:test";
import { matchesFilter } from "../../src/vectors/filter";

describe("matchesFilter", () => {
  test("bare value equality", () => {
    expect(matchesFilter({ genre: "scifi" }, { genre: "scifi" })).toBe(true);
    expect(matchesFilter({ genre: "drama" }, { genre: "scifi" })).toBe(false);
  });

  test("$eq operator", () => {
    expect(matchesFilter({ x: 5 }, { x: { $eq: 5 } })).toBe(true);
    expect(matchesFilter({ x: 6 }, { x: { $eq: 5 } })).toBe(false);
  });

  test("$ne operator", () => {
    expect(matchesFilter({ x: 5 }, { x: { $ne: 3 } })).toBe(true);
    expect(matchesFilter({ x: 5 }, { x: { $ne: 5 } })).toBe(false);
  });

  test("$gt and $gte", () => {
    expect(matchesFilter({ x: 10 }, { x: { $gt: 5 } })).toBe(true);
    expect(matchesFilter({ x: 5 }, { x: { $gt: 5 } })).toBe(false);
    expect(matchesFilter({ x: 5 }, { x: { $gte: 5 } })).toBe(true);
    expect(matchesFilter({ x: 4 }, { x: { $gte: 5 } })).toBe(false);
  });

  test("$lt and $lte", () => {
    expect(matchesFilter({ x: 3 }, { x: { $lt: 5 } })).toBe(true);
    expect(matchesFilter({ x: 5 }, { x: { $lt: 5 } })).toBe(false);
    expect(matchesFilter({ x: 5 }, { x: { $lte: 5 } })).toBe(true);
    expect(matchesFilter({ x: 6 }, { x: { $lte: 5 } })).toBe(false);
  });

  test("$in and $nin", () => {
    expect(matchesFilter({ tag: "a" }, { tag: { $in: ["a", "b"] } })).toBe(true);
    expect(matchesFilter({ tag: "c" }, { tag: { $in: ["a", "b"] } })).toBe(false);
    expect(matchesFilter({ tag: "c" }, { tag: { $nin: ["a", "b"] } })).toBe(true);
    expect(matchesFilter({ tag: "a" }, { tag: { $nin: ["a", "b"] } })).toBe(false);
  });

  test("combined range operators (AND within key)", () => {
    expect(matchesFilter({ year: 2000 }, { year: { $gte: 1990, $lt: 2010 } })).toBe(true);
    expect(matchesFilter({ year: 2020 }, { year: { $gte: 1990, $lt: 2010 } })).toBe(false);
  });

  test("multiple keys ANDed", () => {
    const meta = { genre: "scifi", year: 2000 };
    expect(matchesFilter(meta, { genre: "scifi", year: { $gte: 1990 } })).toBe(true);
    expect(matchesFilter(meta, { genre: "drama", year: { $gte: 1990 } })).toBe(false);
  });

  test("missing metadata returns false", () => {
    expect(matchesFilter(undefined, { x: 1 })).toBe(false);
  });

  test("missing key in metadata returns false for equality", () => {
    expect(matchesFilter({ a: 1 }, { b: 1 })).toBe(false);
  });

  test("boolean filter values", () => {
    expect(matchesFilter({ active: true }, { active: true })).toBe(true);
    expect(matchesFilter({ active: false }, { active: true })).toBe(false);
  });

  test("non-numeric value with $gt returns false", () => {
    expect(matchesFilter({ x: "hello" }, { x: { $gt: 5 } })).toBe(false);
  });
});
