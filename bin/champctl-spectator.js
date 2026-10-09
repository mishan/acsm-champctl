#!/usr/bin/env node
import { run } from "../dist/cli/spectator.js"

await run(process.argv.slice(2))
