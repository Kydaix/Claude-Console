#!/usr/bin/env node
// Claude Console — boot launcher.
//
// Turns a UniSlaw-hosted Node.js server into a live Claude Code terminal.
// UniSlaw starts this app with `npm start` (argv exec, no shell) while the
// process is attached to the panel's interactive PTY console (xterm.js):
// keystrokes, mouse, Ctrl-C and terminal resizes (SIGWINCH) all flow to the
// foreground process group. Because Claude Code is itself a TUI, we just have
// to hand it that PTY untouched.
//
// What this launcher does before exec-ing `claude`:
//   1. Pin HOME onto the persistent server volume, so the one-time
//      subscription login (and history/projects/config) survives a restart.
//      The volume is the ONLY thing shared between the ephemeral install
//      container and the runtime container — nothing else persists.
//   2. Make ripgrep musl-safe: the runtime image is node:*-alpine (musl) and
//      Claude Code's bundled ripgrep is a glibc binary. scripts/postinstall.mjs
//      drops a static-musl `rg` in ./vendor; we put it on PATH and tell Claude
//      Code to use the system one (USE_BUILTIN_RIPGREP=0).
//   3. Keep the console alive: when `claude` exits we relaunch it (with a
//      crash-loop backoff) so the server doesn't look "dead" after `/exit`.
//
// All behaviour is overridable through CLAUDE_CONSOLE_* env vars (set them as
// server variables in the panel). No external dependencies — pure Node.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const HERE = dirname(fileURLToPath(import.meta.url));
const IS_WINDOWS = process.platform === "win32";

// --- configuration (all optional; sane defaults for the UniSlaw runtime) ----

// The persistent server volume. At runtime UniSlaw drops us in /home/container
// (the volume root); locally it's just the repo dir. Everything we want to
// keep across restarts must live under here.
const VOLUME = process.env.CLAUDE_CONSOLE_VOLUME || process.cwd();

// HOME for Claude Code. It writes ~/.claude.json, OAuth credentials, shell
// history and per-project state here, so pointing HOME at the volume is what
// makes "log in once" actually stick across restarts and reinstalls.
const HOME = process.env.CLAUDE_CONSOLE_HOME || join(VOLUME, ".claude-home");

// Where Claude Code actually works (its project root). Kept separate from HOME
// so the user's files never collide with Claude's own config. Set this to "."
// (i.e. CLAUDE_CONSOLE_WORKSPACE=/home/container) to work in the volume root.
const WORKSPACE =
  process.env.CLAUDE_CONSOLE_WORKSPACE || join(VOLUME, "workspace");

// What to do when `claude` exits: relaunch (default — keep the console alive),
// stop (let the server stop), or shell (drop to an interactive shell).
const ON_EXIT = (process.env.CLAUDE_CONSOLE_ON_EXIT || "relaunch").toLowerCase();

// Extra args appended to `claude` (space-split). Empty = interactive session.
const EXTRA_ARGS = (process.env.CLAUDE_CONSOLE_ARGS || "")
  .split(" ")
  .map((s) => s.trim())
  .filter(Boolean);

const VENDOR = join(HERE, "vendor");
const LOCAL_BIN = join(HERE, "node_modules", ".bin");
const RG = join(VENDOR, IS_WINDOWS ? "rg.exe" : "rg");

const CYAN = "\x1b[36m";
const YELLOW = "\x1b[33m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const log = (m) => process.stdout.write(`${CYAN}[claude-console]${RESET} ${m}\n`);
const warn = (m) => process.stderr.write(`${YELLOW}[claude-console] ${m}${RESET}\n`);

// --- prepare the environment -------------------------------------------------

for (const dir of [HOME, WORKSPACE]) {
  if (!existsSync(dir)) {
    try {
      mkdirSync(dir, { recursive: true });
    } catch (err) {
      warn(`could not create ${dir}: ${err.message}`);
    }
  }
}

// Resolve the Claude Code CLI. It's a normal dependency of this repo, so the
// npm-installed shim wins; fall back to whatever `claude` is on PATH.
function resolveClaudeBin() {
  const shim = join(LOCAL_BIN, IS_WINDOWS ? "claude.cmd" : "claude");
  if (existsSync(shim)) return shim;
  return "claude"; // resolved via PATH by spawn(); errors handled below
}

const claudeBin = resolveClaudeBin();

const childEnv = { ...process.env };
childEnv.HOME = HOME;
childEnv.USERPROFILE = HOME; // harmless on POSIX, correct on Windows dev boxes
childEnv.USER = childEnv.USER || "container";
childEnv.TERM = childEnv.TERM || "xterm-256color";
// Local bin first (the claude shim), then vendor (our musl ripgrep), then the
// inherited PATH.
childEnv.PATH = [LOCAL_BIN, VENDOR, childEnv.PATH]
  .filter(Boolean)
  .join(delimiter);
// Only override ripgrep when we actually shipped a system binary, otherwise let
// Claude Code use its own bundled copy (correct on glibc / macOS / Windows).
if (existsSync(RG)) childEnv.USE_BUILTIN_RIPGREP = "0";
// Updates come from reinstalling the server (npm install pulls the latest
// @anthropic-ai/claude-code), not from Claude Code rewriting its own managed
// install at runtime — disable the in-process auto-updater to avoid noise.
childEnv.DISABLE_AUTOUPDATER = childEnv.DISABLE_AUTOUPDATER || "1";

// --- banner ------------------------------------------------------------------

function banner() {
  const credsExist =
    existsSync(join(HOME, ".claude.json")) || existsSync(join(HOME, ".claude"));
  const lines = [
    "",
    `${CYAN}  Claude Console${RESET} ${DIM}— Claude Code CLI, hosted on UniSlaw${RESET}`,
    `${DIM}  workspace: ${WORKSPACE}${RESET}`,
    `${DIM}  home:      ${HOME} (login persists here)${RESET}`,
  ];
  if (!credsExist && !process.env.ANTHROPIC_API_KEY) {
    lines.push(
      `${YELLOW}  First run: Claude Code will ask you to log in. Pick "Log in with`,
      `  Claude", open the URL it prints and paste the code back here. You only`,
      `  do this once — the credentials are saved on the server volume.${RESET}`,
    );
  }
  lines.push("");
  process.stdout.write(lines.join("\n") + "\n");
}

// --- launch loop -------------------------------------------------------------

let shuttingDown = false;
let recentFailures = 0;

function launch() {
  const child = spawn(claudeBin, EXTRA_ARGS, {
    cwd: WORKSPACE,
    env: childEnv,
    stdio: "inherit", // hand the panel's PTY straight to Claude Code
  });

  const startedAt = Date.now();

  // Forward only the lifecycle signals the panel uses to STOP the server. We
  // deliberately do NOT forward SIGINT/SIGWINCH: the controlling terminal
  // already delivers those to the whole foreground process group (Claude Code
  // handles Ctrl-C and resizes itself), so re-forwarding would double them.
  const forward = (sig) => () => {
    shuttingDown = true;
    try {
      child.kill(sig);
    } catch {
      /* already gone */
    }
  };
  const onTerm = forward("SIGTERM");
  const onHup = forward("SIGHUP");
  process.on("SIGTERM", onTerm);
  process.on("SIGHUP", onHup);

  child.on("error", (err) => {
    warn(`failed to start Claude Code (${claudeBin}): ${err.message}`);
    warn(
      "Is @anthropic-ai/claude-code installed? On UniSlaw the Node.js template " +
        "runs `npm install` at install time; locally run `npm install` first.",
    );
    process.exit(127);
  });

  child.on("exit", (code, signal) => {
    process.off("SIGTERM", onTerm);
    process.off("SIGHUP", onHup);

    if (shuttingDown || ON_EXIT === "stop") {
      process.exit(signal ? 1 : code ?? 0);
    }

    if (ON_EXIT === "shell") {
      log("Claude Code exited — dropping to an interactive shell.");
      const sh = IS_WINDOWS ? "powershell" : "/bin/sh";
      spawn(sh, [], { cwd: WORKSPACE, env: childEnv, stdio: "inherit" }).on(
        "exit",
        (c) => process.exit(c ?? 0),
      );
      return;
    }

    // Default: relaunch. Guard against a hot crash loop — if Claude Code keeps
    // dying within a few seconds, back off and finally stop so we never pin the
    // CPU. A clean, long-lived session resets the counter.
    const lived = Date.now() - startedAt;
    if (lived < 3000) {
      recentFailures += 1;
    } else {
      recentFailures = 0;
    }
    if (recentFailures >= 4) {
      warn(
        "Claude Code exited repeatedly within seconds — stopping to avoid a " +
          "crash loop. Check the logs above, then restart the server.",
      );
      process.exit(1);
    }
    const delay = Math.min(1000 * recentFailures, 5000);
    log(
      `Claude Code exited (code ${code ?? "?"}). Relaunching${
        delay ? ` in ${delay / 1000}s` : ""
      }… ${DIM}(set CLAUDE_CONSOLE_ON_EXIT=stop to stop instead)${RESET}`,
    );
    setTimeout(launch, delay);
  });
}

banner();
launch();
