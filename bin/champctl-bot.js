#!/usr/bin/env node
import { run } from "../dist/cli/bot.js"

await run(process.argv.slice(2))
