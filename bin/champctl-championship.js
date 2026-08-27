#!/usr/bin/env node
import { run } from "../dist/cli/championship.js"

await run(process.argv.slice(2))
