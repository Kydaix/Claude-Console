#!/usr/bin/env node
// Claude Console — postinstall.
//
// Provisions the git/bash/ripgrep/ssh toolchain onto the volume during
// `npm install`. This covers hosts that DO run install as root (clean apk
// fetch); boot.mjs also calls ensureToolchain at startup for hosts where the
// only phase is `npm start` as uid 1000. Both are idempotent (marker-guarded).
//
// Must never fail `npm install`: everything is swallowed and we exit 0.

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { ensureToolchain } from "./toolchain.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PREFIX = join(dirname(HERE), "vendor", "toolchain");

const log = (m) => process.stdout.write(`\x1b[36m[claude-console]\x1b[0m ${m}\n`);
const warn = (m) => process.stderr.write(`\x1b[33m[claude-console] ${m}\x1b[0m\n`);

const extra = (process.env.CLAUDE_CONSOLE_TOOLS || "")
  .split(" ")
  .map((s) => s.trim())
  .filter(Boolean);

try {
  await ensureToolchain({ prefix: PREFIX, log, warn, extra });
} catch (err) {
  warn(`toolchain: ${err?.message ?? err}`);
}
process.exit(0);
