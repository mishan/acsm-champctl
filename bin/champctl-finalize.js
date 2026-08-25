#!/usr/bin/env node
import { run } from "../dist/cli/finalize.js"

await run(process.argv.slice(2))
