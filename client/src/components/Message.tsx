interface MessageProps {
  kind: "error" | "info" | "ok"
  title: string
  body?: string | undefined
  children?: React.ReactNode
}

/**
 * One box for everything that went wrong or finished.
 *
 * `body` is always a sentence champctl wrote — an ACSM refusal, a gridmom
 * finding, an engine's explanation of what it declined to do. It is rendered
 * as-is rather than summarised, because those sentences already name the thing
 * and say what happens next, and a UI that rewrites them into "Something went
 * wrong" throws away the only part that helps.
 */
export function Message({ kind, title, body, children }: MessageProps): React.JSX.Element {
  return (
    <div className={`message message-${kind}`} role={kind === "error" ? "alert" : "status"}>
      <strong>{title}</strong>
      {body && <p>{body}</p>}
      {children}
    </div>
  )
}
