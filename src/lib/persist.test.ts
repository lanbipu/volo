import { describe, expect, it } from "vitest";
import { persistKey } from "./persist";

describe("persistKey", () => {
  it("按域加前缀", () => {
    expect(persistKey("shell")).toBe("volo:shell");
    expect(persistKey("calibrate.grid")).toBe("volo:calibrate.grid");
  });
  it("拒绝不合法域名", () => {
    expect(() => persistKey("Shell")).toThrow();
    expect(() => persistKey("a b")).toThrow();
    expect(() => persistKey("")).toThrow();
  });
});
