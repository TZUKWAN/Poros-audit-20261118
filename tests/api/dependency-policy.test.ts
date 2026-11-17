import { it, expect } from "vitest";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const match = require("picomatch") as {
  isMatch: (input: string, pattern: string) => boolean;
  makeRe: (pattern: string) => RegExp;
};
it("private matcher fork rejects vulnerable repeated extglobs before regex compilation", () => {
  for (const pattern of ["+(*)", "+(*a)", "*(*)", "+(?*a)", "**/+(*a).ts"])
    expect(() => match.makeRe(pattern)).toThrow(/Repeated extglobs/);
});
it("required ordinary globs and braces still match real build/test path shapes", () => {
  expect(match.isMatch("src/server/app.ts", "src/**/*.ts")).toBe(true);
  expect(match.isMatch("web/src/App.tsx", "web/**/*.{ts,tsx}")).toBe(true);
  expect(match.isMatch("secrets.env", "**/*.ts")).toBe(false);
});
