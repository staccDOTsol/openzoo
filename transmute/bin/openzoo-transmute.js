#!/usr/bin/env node
// `openzoo-transmute build|deploy|serve|inspect|status|help` — see lib/cli.js.
import { run } from '../lib/cli.js';

const code = await run(process.argv.slice(2));
// `serve` returns 0 while its server keeps the loop alive; only bail on failure.
if (code) process.exit(code);
