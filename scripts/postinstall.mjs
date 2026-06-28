#!/usr/bin/env node
// Claude Console — postinstall: provision a musl-safe ripgrep.
//
// WHY this exists. On UniSlaw the Node.js template installs the app inside an
// ephemeral root container (node:*-alpine, with internet) and runs it later in
// a SEPARATE alpine container as uid 1000. The two share only the server
// volume, so we cannot `apk add` anything at runtime — whatever the runtime
// needs has to be written to the volume now, during `npm install`.
//
// Claude Code ships a bundled ripgrep built against glibc; it does not run on
// alpine's musl. We download a STATIC ripgrep here (musl static binaries run on
// both musl and glibc) and drop it in ./vendor/rg. boot.mjs then puts ./vendor
// on PATH and sets USE_BUILTIN_RIPGREP=0 so Claude Code uses it.
//
// This must NEVER fail the install: a missing ripgrep only degrades search, it
// does not stop Claude Code from launching. So every failure path warns and
// exits 0. On non-Linux dev machines we skip entirely (the bundled ripgrep is
// fine there).

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);
const VENDOR = join(ROOT, "vendor");

const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const RESET = "\x1b[0m";
const log = (m) => process.stdout.write(`${CYAN}[claude-console]${RESET} ${m}\n`);
const warn = (m) =>
  process.stderr.write(`${YELLOW}[claude-console] ${m}${RESET}\n`);

// Pin a known ripgrep release. Bump deliberately; static musl is portable.
const RG_VERSION = "14.1.1";
const TARGETS = {
  x64: "x86_64-unknown-linux-musl",
  arm64: "aarch64-unknown-linux-musl",
};

async function main() {
  if (process.platform !== "linux") {
    // macOS / Windows dev: Claude Code's bundled ripgrep works; nothing to do.
    return;
  }

  const rgPath = join(VENDOR, "rg");
  if (existsSync(rgPath)) {
    log("vendor ripgrep already present — skipping download.");
    return;
  }

  const triple = TARGETS[process.arch];
  if (!triple) {
    warn(
      `no static ripgrep mapping for arch "${process.arch}" — search may be ` +
        "degraded. The supported UniSlaw runtime target is linux/amd64.",
    );
    return;
  }

  const stem = `ripgrep-${RG_VERSION}-${triple}`;
  const url = `https://github.com/BurntSushi/ripgrep/releases/download/${RG_VERSION}/${stem}.tar.gz`;
  const tmpTar = join(VENDOR, `${stem}.tar.gz`);

  try {
    mkdirSync(VENDOR, { recursive: true });

    log(`Downloading ripgrep ${RG_VERSION} (${triple})…`);
    const res = await fetch(url, { redirect: "follow" });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} for ${url}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    writeFileSync(tmpTar, buf);

    // Log the checksum so it can be pinned later; we trust the HTTPS source.
    const sha = createHash("sha256").update(buf).digest("hex");
    log(`Fetched ${buf.length} bytes (sha256 ${sha.slice(0, 16)}…).`);

    // Extract just the `rg` binary. busybox tar (alpine) supports this; so does
    // GNU tar. --strip-components=1 drops the versioned top-level directory.
    const extract = spawnSync(
      "tar",
      ["xzf", tmpTar, "-C", VENDOR, "--strip-components=1", `${stem}/rg`],
      { stdio: "inherit" },
    );
    if (extract.status !== 0) {
      throw new Error(`tar exited with ${extract.status ?? extract.signal}`);
    }

    if (!existsSync(rgPath)) {
      throw new Error("tar succeeded but vendor/rg is missing");
    }
    chmodSync(rgPath, 0o755);
    // Sanity check it actually runs on this libc.
    const probe = spawnSync(rgPath, ["--version"], { encoding: "utf8" });
    if (probe.status === 0) {
      log(`ripgrep ready: ${(probe.stdout || "").split("\n")[0]}`);
    } else {
      warn("vendor/rg installed but did not run cleanly; search may degrade.");
    }
  } catch (err) {
    warn(
      `could not provision ripgrep (${err.message}). Claude Code will still ` +
        "launch; only its search/grep tools may be degraded on alpine.",
    );
  } finally {
    if (existsSync(tmpTar)) {
      try {
        rmSync(tmpTar);
      } catch {
        /* best effort */
      }
    }
  }
}

// Never break `npm install`: swallow everything and exit 0.
main()
  .catch((err) => warn(`unexpected: ${err?.message ?? err}`))
  .finally(() => process.exit(0));
