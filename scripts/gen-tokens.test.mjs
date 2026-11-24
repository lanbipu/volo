import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { generate } from "./gen-tokens.mjs";

const ROOT = new URL("..", import.meta.url).pathname;

describe("gen-tokens", () => {
  it("与 DS artifact 自带的 CSS（06-css-variables.md）逐字节一致", () => {
    const tokens = JSON.parse(readFileSync(`${ROOT}src/ui/tokens.json`, "utf8"));
    const expected = readFileSync(`${ROOT}scripts/frontend/tokens.expected.css`, "utf8");
    expect(generate(tokens)).toBe(expected);
  });
});
