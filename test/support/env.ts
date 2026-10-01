/**
 * The environment variables that change a CLI's defaults, cleared before every
 * test file.
 *
 * A deployment exports these, and a test run on that host inherited them: the
 * profile and pit table under test became the league's own, and tests that
 * assert the built-in defaults failed for a reason that had nothing to do with
 * the code. Tests that want one set it with `vi.stubEnv`.
 */
for (const name of ["CHAMPCTL_PROFILE", "CHAMPCTL_PITS", "CHAMPCTL_STORE"]) {
  delete process.env[name]
}
