import { createRoot } from "react-dom/client"

import { App } from "./App"
import "./styles.css"

const root = document.getElementById("root")
if (!root) throw new Error("No #root element; index.html and main.tsx disagree.")

/**
 * Deliberately not wrapped in `<StrictMode>`.
 *
 * StrictMode runs every effect twice in development, and the effect that
 * matters on the finalize screen fetches a preview — which is a real request to
 * ACSM's event edit form, against a service documented at five requests per
 * twenty seconds, and which allocates a server-side plan each time. Doubling
 * that on every keystroke to catch effect-cleanup bugs is a bad trade for a
 * screen with one effect in it.
 */
createRoot(root).render(<App />)
