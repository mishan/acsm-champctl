#!/usr/bin/env node
import { run } from "../dist/cli/gridmom.js"

await run(process.argv.slice(2))
