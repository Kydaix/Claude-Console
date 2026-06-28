#!/usr/bin/env node
// Claude Console — boot launcher.
//
// Turns a UniSlaw-hosted Node.js server into a live Claude Code terminal.
// The host starts this app with `npm start` (argv exec, no shell) while the
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
//   2. GUARANTEE Claude Code is actually installed. Claude Code v2 ships as a
//      ~224 MB native binary delivered through per-platform OPTIONAL deps. An
//      optional dep that fails to download does NOT fail `npm install` (it
//      exits 0), so a server can reach runtime with no usable `claude`. We
//      detect that and self-heal by installing it here (one-time, on the
//      volume), so it works on UniSlaw and on any other Node host.
//   3. Make ripgrep musl-safe (defensive): if scripts/postinstall.mjs dropped a
//      static-musl `rg` in ./vendor, expose it and set USE_BUILTIN_RIPGREP=0.
//   4. Launch the native binary DIRECTLY (not via the .bin/claude shim or PATH,
//      which may be missing/dangling), and keep the console alive across exits.
//
// All behaviour is overridable through CLAUDE_CONSOLE_* env vars (set them as
// server variables in the panel). No external dependencies — pure Node.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
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

// Allow disabling the runtime self-heal install (e.g. air-gapped hosts).
const AUTO_INSTALL = process.env.CLAUDE_CONSOLE_AUTO_INSTALL !== "0";

// Where this repo's dependencies live (claude-code is one of them).
const APP = HERE;
const CC_DIR = join(APP, "node_modules", "@anthropic-ai", "claude-code");
// claude-code's bin is literally named "claude.exe" on every platform (on Linux
// it's just an ELF binary that happens to carry that name). The postinstall
// copies the real ~200 MB native binary over a tiny placeholder stub.
const CC_BIN = join(CC_DIR, "bin", "claude.exe");
const CC_WRAPPER = join(CC_DIR, "cli-wrapper.cjs");
const REAL_BINARY_MIN_BYTES = 5_000_000; // stub is a few KB; real binary >200 MB

const VENDOR = join(HERE, "vendor");
const LOCAL_BIN = join(HERE, "node_modules", ".bin");
const RG = join(VENDOR, IS_WINDOWS ? "rg.exe" : "rg");

// Self-contained toolchain (git/bash/ripgrep/ssh + their libs) that
// scripts/postinstall.mjs installs onto the volume with `apk add --root` at
// install time. Present only on alpine hosts where provisioning succeeded.
const TOOLCHAIN = join(VENDOR, "toolchain");
const TC_BIN = [
  join(TOOLCHAIN, "usr", "bin"),
  join(TOOLCHAIN, "usr", "sbin"),
  join(TOOLCHAIN, "bin"),
  join(TOOLCHAIN, "usr", "libexec", "git-core"),
];
const TC_LIB = [join(TOOLCHAIN, "usr", "lib"), join(TOOLCHAIN, "lib")];
const TC_CA = join(TOOLCHAIN, "etc", "ssl", "certs", "ca-certificates.crt");

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

const haveToolchain = existsSync(join(TOOLCHAIN, "usr", "bin"));

const childEnv = { ...process.env };
childEnv.HOME = HOME;
childEnv.USERPROFILE = HOME; // harmless on POSIX, correct on Windows dev boxes
childEnv.USER = childEnv.USER || "container";
childEnv.TERM = childEnv.TERM || "xterm-256color";

// PATH: volume toolchain first (git/bash/rg…), then the local npm bin + vendor.
childEnv.PATH = [...(haveToolchain ? TC_BIN : []), LOCAL_BIN, VENDOR, childEnv.PATH]
  .filter(Boolean)
  .join(delimiter);

// Wire up the provisioned toolchain so its binaries find their libs, helpers
// and CA bundle (the runtime base image only ships busybox + node).
if (haveToolchain) {
  childEnv.LD_LIBRARY_PATH = [...TC_LIB, childEnv.LD_LIBRARY_PATH]
    .filter(Boolean)
    .join(delimiter);
  childEnv.GIT_EXEC_PATH = join(TOOLCHAIN, "usr", "libexec", "git-core");
  childEnv.GIT_TEMPLATE_DIR = join(TOOLCHAIN, "usr", "share", "git-core", "templates");
  if (existsSync(TC_CA)) {
    // https git clone, ssl in general — point every common knob at the bundle.
    childEnv.GIT_SSL_CAINFO = childEnv.GIT_SSL_CAINFO || TC_CA;
    childEnv.SSL_CERT_FILE = childEnv.SSL_CERT_FILE || TC_CA;
    childEnv.CURL_CA_BUNDLE = childEnv.CURL_CA_BUNDLE || TC_CA;
    childEnv.NODE_EXTRA_CA_CERTS = childEnv.NODE_EXTRA_CA_CERTS || TC_CA;
  }
}

// Claude Code's Bash tool reads $SHELL to find a POSIX shell. Container images
// (alpine) usually leave SHELL unset → "No suitable shell found". Prefer the
// provisioned bash, then any system shell (busybox provides /bin/sh on alpine).
if (!IS_WINDOWS && (!childEnv.SHELL || !existsSync(childEnv.SHELL))) {
  const shell = [
    join(TOOLCHAIN, "usr", "bin", "bash"),
    "/bin/bash",
    "/usr/bin/bash",
    "/bin/sh",
    "/usr/bin/sh",
  ].find((s) => existsSync(s));
  if (shell) childEnv.SHELL = shell;
  else warn("no POSIX shell found on PATH — Claude Code's Bash tool will fail.");
}

// Use the system ripgrep (provisioned, or vendored) instead of the bundled one.
if (existsSync(join(TOOLCHAIN, "usr", "bin", "rg")) || existsSync(RG)) {
  childEnv.USE_BUILTIN_RIPGREP = "0";
}
// Updates come from reinstalling the server, not from the binary rewriting its
// own managed install at runtime — silence the in-process auto-updater.
childEnv.DISABLE_AUTOUPDATER = childEnv.DISABLE_AUTOUPDATER || "1";

// --- ensure Claude Code is installed (self-heal) -----------------------------

// Returns a spawnable target { cmd, args } or null. Prefers the native binary;
// falls back to the Node wrapper (resolves the platform pkg itself) if only a
// stub was placed (e.g. installed with --ignore-scripts).
function resolveTarget() {
  if (existsSync(CC_BIN) && statSync(CC_BIN).size >= REAL_BINARY_MIN_BYTES) {
    return { cmd: CC_BIN, args: EXTRA_ARGS };
  }
  if (existsSync(CC_WRAPPER)) {
    // The wrapper require.resolve()s the matching @anthropic-ai/claude-code-*
    // platform package and execs its binary; works whenever that optional dep
    // is present even if the placeholder wasn't replaced.
    return { cmd: process.execPath, args: [CC_WRAPPER, ...EXTRA_ARGS] };
  }
  return null;
}

function runNpmInstall() {
  log(
    "Claude Code is missing or incomplete — installing it now. This is a " +
      "one-time ~200 MB download; it is saved on the server volume.",
  );
  const npm = IS_WINDOWS ? "npm.cmd" : "npm";
  const res = spawnSync(
    npm,
    ["install", "--no-audit", "--no-fund", "--omit=dev"],
    { cwd: APP, env: childEnv, stdio: "inherit" },
  );
  if (res.error) {
    warn(`could not run npm (${res.error.message}).`);
    return false;
  }
  return res.status === 0;
}

function ensureClaude() {
  let target = resolveTarget();
  if (target) return target;

  if (!AUTO_INSTALL) {
    warn("Claude Code is not installed and CLAUDE_CONSOLE_AUTO_INSTALL=0.");
    return null;
  }

  // Two attempts: the 224 MB optional binary occasionally fails the first time
  // on a slow/over-quota host, and a clean retry usually lands it.
  for (let attempt = 1; attempt <= 2 && !target; attempt += 1) {
    if (attempt > 1) log("Retrying the Claude Code install…");
    runNpmInstall();
    target = resolveTarget();
  }
  return target;
}

// --- banner ------------------------------------------------------------------

function banner() {
  const credsExist =
    existsSync(join(HOME, ".claude.json")) || existsSync(join(HOME, ".claude"));
  const lines = [
    "",
    `${CYAN}  Claude Console${RESET} ${DIM}— Claude Code CLI, hosted on UniSlaw${RESET}`,
    `${DIM}  workspace: ${WORKSPACE}${RESET}`,
    `${DIM}  home:      ${HOME} (login persists here)${RESET}`,
    `${DIM}  toolchain: ${
      haveToolchain ? "git, bash, ripgrep (volume)" : "busybox only (no git/bash)"
    }${RESET}`,
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

function launch(target) {
  const child = spawn(target.cmd, target.args, {
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
    warn(`failed to start Claude Code (${target.cmd}): ${err.message}`);
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
    setTimeout(() => launch(target), delay);
  });
}

// --- main --------------------------------------------------------------------

banner();

const target = ensureClaude();
if (!target) {
  warn(
    "Claude Code could not be installed. Check the server has internet access " +
      "and enough disk for a ~200 MB binary, then restart. You can also set " +
      "GIT_REPO and reinstall the server so `npm install` runs at install time.",
  );
  process.exit(127);
}

launch(target);
