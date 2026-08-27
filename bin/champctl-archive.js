#!/usr/bin/env node
import { run } from "../dist/cli/archive.js"

await run(process.argv.slice(2))
