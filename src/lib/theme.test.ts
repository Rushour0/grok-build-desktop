/// Tests for the pure theme helpers in theme.ts. applyTheme is a DOM-apply
/// helper, so we exercise it against a plain object shaped like the bits of
/// HTMLElement it actually touches (a `dataset` map) rather than requiring a
/// real DOM — this keeps the suite fast and honest about the actual contract.
import { describe, expect, it } from "vitest";
import { applyTheme, isThemePref, resolveTheme, type ThemePref } from "./theme";

// A minimal stand-in for HTMLElement that only implements `.dataset`, which
// is all applyTheme touches. Using `as unknown as HTMLElement` mirrors the
// pattern the frozen API expects (a real HTMLElement in production, a fake
// here) without pulling in jsdom machinery this suite doesn't need.
function fakeRoot(): HTMLElement {
  return { dataset: {} } as unknown as HTMLElement;
}

// ---- isThemePref ----

describe("isThemePref", () => {
  it("accepts the three valid theme preferences", () => {
    expect(isThemePref("light")).toBe(true);
    expect(isThemePref("dark")).toBe(true);
    expect(isThemePref("system")).toBe(true);
  });

  it("rejects junk strings", () => {
    expect(isThemePref("Light")).toBe(false);
    expect(isThemePref("DARK")).toBe(false);
    expect(isThemePref("auto")).toBe(false);
    expect(isThemePref("")).toBe(false);
    expect(isThemePref("light ")).toBe(false);
  });

  it("rejects non-string values", () => {
    expect(isThemePref(null)).toBe(false);
    expect(isThemePref(undefined)).toBe(false);
    expect(isThemePref(42)).toBe(false);
    expect(isThemePref(true)).toBe(false);
    expect(isThemePref({})).toBe(false);
    expect(isThemePref(["light"])).toBe(false);
  });
});

// ---- resolveTheme ----

describe("resolveTheme", () => {
  it("system + prefersDark=true resolves to dark", () => {
    expect(resolveTheme("system", true)).toBe("dark");
  });

  it("system + prefersDark=false resolves to light", () => {
    expect(resolveTheme("system", false)).toBe("light");
  });

  it("explicit light passes through regardless of OS signal", () => {
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("light", false)).toBe("light");
  });

  it("explicit dark passes through regardless of OS signal", () => {
    expect(resolveTheme("dark", true)).toBe("dark");
    expect(resolveTheme("dark", false)).toBe("dark");
  });
});

// ---- applyTheme ----

describe("applyTheme", () => {
  it('sets data-theme="dark" on the root for pref "dark"', () => {
    const root = fakeRoot();
    applyTheme("dark", root);
    expect(root.dataset.theme).toBe("dark");
  });

  it('sets data-theme="light" on the root for pref "light"', () => {
    const root = fakeRoot();
    applyTheme("light", root);
    expect(root.dataset.theme).toBe("light");
  });

  it('removes data-theme from the root for pref "system"', () => {
    const root = fakeRoot();
    root.dataset.theme = "dark"; // pre-existing explicit value
    applyTheme("system", root);
    expect(root.dataset.theme).toBeUndefined();
    expect("theme" in root.dataset).toBe(false);
  });

  it('"system" is a no-op (stays absent) when data-theme was never set', () => {
    const root = fakeRoot();
    applyTheme("system", root);
    expect(root.dataset.theme).toBeUndefined();
  });

  it("switching light -> dark -> system leaves a clean root", () => {
    const root = fakeRoot();
    applyTheme("light", root);
    expect(root.dataset.theme).toBe("light");
    applyTheme("dark", root);
    expect(root.dataset.theme).toBe("dark");
    applyTheme("system", root);
    expect(root.dataset.theme).toBeUndefined();
  });

  it("round-trips through all valid ThemePref values without throwing", () => {
    const prefs: ThemePref[] = ["light", "dark", "system"];
    for (const pref of prefs) {
      const root = fakeRoot();
      expect(() => applyTheme(pref, root)).not.toThrow();
    }
  });
});
