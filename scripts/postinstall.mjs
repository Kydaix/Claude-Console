#!/usr/bin/env node
// Claude Console — postinstall: provision a self-contained toolchain on the volume.
//
// WHY this exists. On UniSlaw (and Pterodactyl-style hosts) the Node.js template
// installs the app inside an ephemeral ROOT container (node:*-alpine, with apk +
// internet) and runs it later in a SEPARATE alpine container as uid 1000. The two
// share only the server volume. So:
//   - we cannot `apk add` at runtime (non-root, and a separate container), and
//   - the base runtime image only ships busybox + node + npm — no git, no bash,
//     no ripgrep.
//
// The fix: at install time (root) we install a full alpine package set INTO A
// PREFIX ON THE VOLUME (`vendor/toolchain`) with `apk add --root`. apk resolves
// every dependency (.so libs, git's helper binaries, CA bundle) into that prefix.
// At runtime boot.mjs puts the prefix's bin dirs on PATH and its lib dirs on
// LD_LIBRARY_PATH — the binaries run because install and runtime share the same
// node:*-alpine base (same musl loader at /lib/ld-musl-*.so). Result: `git`,
// `bash`, `ripgrep`, ssh, etc. are available inside the hosted Claude Code.
//
// This must NEVER fail `npm install`: a missing toolchain only means the hosted
// shell falls back to busybox. Every failure path warns and exits 0. It is also a
// no-op when apk is absent (dev machines) or when we are not root (the runtime
// self-heal `npm install`, which only needs the already-provisioned prefix).

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);
const PREFIX = join(ROOT, "vendor", "toolchain");

const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const RESET = "\x1b[0m";
const log = (m) => process.stdout.write(`${CYAN}[claude-console]${RESET} ${m}\n`);
const warn = (m) =>
  process.stderr.write(`${YELLOW}[claude-console] ${m}${RESET}\n`);

// Essential set — all in the alpine *main* repo, so it installs even when the
// community repo is disabled. git/bash must always survive.
const ESSENTIAL_PACKAGES = [
  "ca-certificates-bundle", // /etc/ssl/certs/ca-certificates.crt for https git
  "git",
  "openssh-client", // git over ssh
  "bash",
  "less", // git pager
];
// Nice-to-haves — some live in the *community* repo (git-lfs, ripgrep), which is
// why they're separated: apk is atomic, so one missing package would otherwise
// sink the whole transaction (including git).
const EXTRA_PACKAGES = ["git-lfs", "ripgrep"];

function commandWorks(cmd, args) {
  const res = spawnSync(cmd, args, { stdio: "ignore" });
  return !res.error && res.status === 0;
}

function main() {
  if (process.platform !== "linux") {
    return; // dev machines (macOS/Windows): nothing to provision
  }
  if (typeof process.getuid === "function" && process.getuid() !== 0) {
    // Runtime self-heal install runs as uid 1000 — can't apk; prefix (if any)
    // was already built at install time. Don't warn: this is expected.
    return;
  }
  if (!commandWorks("apk", ["--version"])) {
    warn("`apk` not found — skipping toolchain (git/bash/ripgrep) provisioning.");
    return;
  }
  if (existsSync(join(PREFIX, "usr", "bin", "git"))) {
    log("toolchain already provisioned on the volume — skipping.");
    return;
  }

  const extra = (process.env.CLAUDE_CONSOLE_TOOLS || "")
    .split(" ")
    .map((s) => s.trim())
    .filter(Boolean);

  // apk add into a prefix: --initdb creates the package DB there, and we point
  // it at the host's repositories + signing keys so it resolves everything.
  const apkAdd = (packages) =>
    spawnSync(
      "apk",
      [
        "add",
        "-p",
        PREFIX,
        "--initdb",
        "--no-cache",
        "--repositories-file",
        "/etc/apk/repositories",
        "--keys-dir",
        "/etc/apk/keys",
        ...packages,
      ],
      { stdio: "inherit" },
    );

  try {
    mkdirSync(PREFIX, { recursive: true });
    const full = [...ESSENTIAL_PACKAGES, ...EXTRA_PACKAGES, ...extra];
    log(`Provisioning toolchain on the volume (${full.join(", ")})…`);
    let res = apkAdd(full);
    if (res.error) throw res.error;
    if (res.status !== 0) {
      // A community-repo package (ripgrep/git-lfs) may be unavailable. Retry
      // with the essentials only so git/bash still land.
      warn("full toolchain failed — retrying with the essential packages only.");
      res = apkAdd(ESSENTIAL_PACKAGES);
      if (res.error) throw res.error;
      if (res.status !== 0) {
        throw new Error(`apk exited with ${res.status ?? res.signal}`);
      }
    }

    // Sanity check: run the provisioned git through the same loader/libs the
    // runtime will use (LD_LIBRARY_PATH into the prefix).
    const probe = spawnSync(join(PREFIX, "usr", "bin", "git"), ["--version"], {
      encoding: "utf8",
      env: {
        ...process.env,
        LD_LIBRARY_PATH: [
          join(PREFIX, "usr", "lib"),
          join(PREFIX, "lib"),
          process.env.LD_LIBRARY_PATH,
        ]
          .filter(Boolean)
          .join(":"),
      },
    });
    if (probe.status === 0) {
      log(`toolchain ready: ${(probe.stdout || "").trim()}`);
    } else {
      warn("toolchain installed but `git --version` did not run cleanly.");
    }
  } catch (err) {
    warn(
      `could not provision the toolchain (${err.message}). Claude Code still ` +
        "works; the hosted shell falls back to busybox (no git/bash).",
    );
  }
}

// Never break `npm install`: swallow everything and exit 0.
try {
  main();
} catch (err) {
  warn(`unexpected: ${err?.message ?? err}`);
}
process.exit(0);
