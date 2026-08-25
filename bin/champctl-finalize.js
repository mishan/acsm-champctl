#!/usr/bin/env node
import { runCli } from "../dist/cli/finalize.js"

await runCli(process.argv.slice(2))
