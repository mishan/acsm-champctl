#!/usr/bin/env node
import { runCli } from "../dist/cli/month.js"

await runCli(process.argv.slice(2))
