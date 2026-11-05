/** Which release is running, linked to what's in it. A build outside a release has no notes. */
export function Version({ version }: { version: string }): React.JSX.Element {
  return (
    <footer className="version">
      champctl{" "}
      {version === "dev" ? (
        version
      ) : (
        <a
          href={`https://github.com/mishan/acsm-champctl/releases/tag/${encodeURIComponent(version)}`}
        >
          {version}
        </a>
      )}
    </footer>
  )
}
