#!/usr/bin/env node
import { run } from "../dist/cli/mcp.js"

await run(process.argv.slice(2))
