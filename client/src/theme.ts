/**
 * The league's colors over the stylesheet's defaults.
 *
 * Each key names one of the variables on `:root` in `styles.css`, in the
 * profile's camelCase: `surface2` is `--surface-2`. Replaces whatever was
 * applied before, so a color taken out of the profile goes back to its default.
 */
export function applyTheme(theme: Record<string, string>, root = document.documentElement): void {
  const set = Array.from({ length: root.style.length }, (_, i) => root.style.item(i))
  for (const name of set) if (name.startsWith("--")) root.style.removeProperty(name)
  for (const [key, color] of Object.entries(theme)) {
    root.style.setProperty(`--${key.replace(/[A-Z0-9]/g, (c) => `-${c.toLowerCase()}`)}`, color)
  }
}

const KEY = "champctl.theme"

/**
 * Kept in the browser so the next load starts in the league's colors. The
 * config arrives only after the first paint, and every load flashed the
 * defaults until it did. Storage that can't be used costs only that flash.
 */
export function rememberTheme(theme: Record<string, string>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(theme))
  } catch {}
}

export function rememberedTheme(): Record<string, string> {
  try {
    const kept: unknown = JSON.parse(localStorage.getItem(KEY) ?? "{}")
    return kept && typeof kept === "object" ? (kept as Record<string, string>) : {}
  } catch {
    return {}
  }
}
