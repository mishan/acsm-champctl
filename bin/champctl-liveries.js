#!/usr/bin/env node
import { run } from "../dist/cli/liveries.js"

await run(process.argv.slice(2))
