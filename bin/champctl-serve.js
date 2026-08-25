#!/usr/bin/env node
import { run } from "../dist/cli/serve.js"

await run(process.argv.slice(2))
