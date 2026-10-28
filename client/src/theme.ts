/**
 * The league's colors over the stylesheet's defaults.
 *
 * Each key names one of the variables on `:root` in `styles.css`, in the
 * profile's camelCase: `surface2` is `--surface-2`.
 */
export function applyTheme(theme: Record<string, string>, root = document.documentElement): void {
  for (const [key, color] of Object.entries(theme)) {
    root.style.setProperty(`--${key.replace(/[A-Z0-9]/g, (c) => `-${c.toLowerCase()}`)}`, color)
  }
}
