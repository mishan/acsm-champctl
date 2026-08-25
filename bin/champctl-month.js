#!/usr/bin/env node
import { run } from "../dist/cli/month.js"

await run(process.argv.slice(2))
