#!/usr/bin/env node
import { run } from "../dist/cli/upload.js"

await run(process.argv.slice(2))
