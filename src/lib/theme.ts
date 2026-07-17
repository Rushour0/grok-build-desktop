// Theme preference helpers — pure/DOM-apply only, no React.
//
// A "theme preference" is what the user chose (persisted to localStorage);
// the "resolved theme" is the concrete light/dark value actually painted,
// taking the OS-level `prefers-color-scheme` into account when the user's
// preference is "system".

/** The set of theme preferences a user can pick in Preferences > Appearance. */
export type ThemePref = "light" | "dark" | "system";

const THEME_PREFS: readonly ThemePref[] = ["light", "dark", "system"];

/**
 * Validate an arbitrary value (e.g. read back from localStorage) as a
 * ThemePref. Narrows `unknown` so callers can safely fall back to a default
 * ("system") when the stored value is missing, corrupted, or from an older
 * app version that used a different shape.
 */
export function isThemePref(v: unknown): v is ThemePref {
  return typeof v === "string" && (THEME_PREFS as readonly string[]).includes(v);
}

/**
 * Resolve the effective "light"|"dark" paint given a preference and the
 * current OS `prefers-color-scheme: dark` match. "system" defers entirely
 * to the OS signal; "light"/"dark" are explicit overrides.
 */
export function resolveTheme(pref: ThemePref, prefersDark: boolean): "light" | "dark" {
  if (pref === "system") {
    return prefersDark ? "dark" : "light";
  }
  return pref;
}

/**
 * Apply a theme preference to the document root.
 *
 * For "system", we REMOVE the `data-theme` attribute so the CSS
 * `@media (prefers-color-scheme: dark)` rules take back over (this keeps
 * "system" always in sync with OS changes without needing to resolve a
 * concrete value here). For "light"/"dark", we set `data-theme` explicitly
 * so the `:root[data-theme="..."]` CSS blocks win regardless of the OS
 * setting.
 */
export function applyTheme(pref: ThemePref, root: HTMLElement = document.documentElement): void {
  if (pref === "system") {
    delete root.dataset.theme;
  } else {
    root.dataset.theme = pref;
  }
}
