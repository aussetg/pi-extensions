import { describe, expect, it } from "vitest";
import { stableJson } from "../src/utils/stable-json.js";

describe("stableJson", () => {
  it("sorts keys", () => {
    expect(stableJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  it("rejects non-json", () => {
    expect(() => stableJson({ x: undefined })).toThrow(/undefined/);
    expect(() => stableJson({ x: Number.NaN })).toThrow(/Non-finite/);
  });
});
