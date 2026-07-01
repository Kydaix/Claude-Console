// Claude Console — optional RTK (Rust Token Killer) provisioning.
//
// RTK (github.com/rtk-ai/rtk) sits in front of dev commands (git/cargo/npm/
// docker/…) and compresses their output before it reaches the model, cutting
// Claude Code's token use by ~60-90% in a typical session. It ships a single,
// fully-static musl binary that runs as-is on the alpine runtime, needs no root,
// and — exactly like the git/bash/ripgrep toolchain — lives on the volume. It is
// opt-in: set CLAUDE_CONSOLE_RTK=1 to enable it.
//
// Provisioning mirrors the rest of the project (dep-free, non-root, idempotent):
//   1. Download the GitHub release tarball. It's a single `rtk` executable at the
//      archive root, so the toolchain's own dep-free tar reader (extractApk)
//      drops it straight into the toolchain's usr/bin — already on PATH.
//   2. Run `rtk init -g --auto-patch` ONCE. That registers RTK's Bash PreToolUse
//      hook in the pinned HOME's ~/.claude/settings.json (`-g` = global config,
//      `--auto-patch` = write without an interactive prompt, since this console
//      runs unattended). Because HOME is on the volume, the integration — like
//      the login — survives restarts.
// A marker file short-circuits later boots. Nothing here throws into boot.mjs;
// failures degrade to "RTK not installed", never a broken console.

import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { extractApk } from "./toolchain.mjs";

const REPO = "rtk-ai/rtk";

// x86_64 gets the fully-static musl build (runs natively on the alpine base).
// arm64 only has a glibc build upstream, so it is best-effort — matching the
// project's stance that linux/amd64 is the supported target.
const TARGET = {
  x64: "x86_64-unknown-linux-musl",
  arm64: "aarch64-unknown-linux-gnu",
};

// Provision RTK into `prefix` and wire it into Claude Code under `env.HOME`.
// `env` is boot.mjs's childEnv: we both run `rtk init` with it AND mutate its
// PATH so the launched Claude Code (and RTK's hook, which calls `rtk` by name)
// can find the binary. Idempotent via a marker. Returns { hasRtk }.
export async function ensureRtk({ prefix, env, log, warn }) {
  if (process.platform === "win32") return { hasRtk: false };

  const binDir = join(prefix, "usr", "bin");
  const rtkBin = join(binDir, "rtk");
  const marker = join(prefix, ".rtk-installed");

  // Keep binDir on PATH whether or not we (re)install this boot — the hook shells
  // out to plain `rtk`. binDir is normally already on PATH via the toolchain, but
  // guarantee it so RTK works even if the wider toolchain came up short.
  const ensureOnPath = () => {
    if (!(env.PATH || "").split(delimiter).includes(binDir)) {
      env.PATH = [binDir, env.PATH].filter(Boolean).join(delimiter);
    }
  };

  if (existsSync(marker) && existsSync(rtkBin)) {
    ensureOnPath();
    return { hasRtk: true };
  }

  const target = TARGET[process.arch];
  if (!target) {
    warn(`RTK: no prebuilt binary for arch ${process.arch}; skipping.`);
    return { hasRtk: false };
  }

  // 1. Fetch + extract the binary (unless a good copy is already on the volume).
  if (!existsSync(rtkBin)) {
    const url = `https://github.com/${REPO}/releases/latest/download/rtk-${target}.tar.gz`;
    try {
      log("Installing RTK (Rust Token Killer) — a token-saving command proxy…");
      const res = await fetch(url, { redirect: "follow" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      mkdirSync(binDir, { recursive: true });
      // The tarball is a lone `rtk` executable at its root; extractApk (zlib +
      // the toolchain's ustar reader) writes it straight into binDir.
      extractApk(buf, binDir);
      if (!existsSync(rtkBin)) {
        throw new Error("archive did not contain an rtk binary");
      }
      chmodSync(rtkBin, 0o755);
    } catch (err) {
      warn(`RTK install failed: ${err.message}`);
      return { hasRtk: false };
    }
  }

  ensureOnPath();

  // 2. Register the Claude Code integration once. init needs ~/.claude to exist;
  //    boot.mjs creates HOME but not that subdir, so make sure it's there.
  try {
    if (env.HOME) mkdirSync(join(env.HOME, ".claude"), { recursive: true });
    const r = spawnSync(rtkBin, ["init", "-g", "--auto-patch"], {
      env,
      stdio: "inherit",
    });
    if (r.error) throw r.error;
  } catch (err) {
    warn(`RTK init failed (binary installed, hook not registered): ${err.message}`);
  }

  try {
    writeFileSync(marker, "ok\n");
  } catch {
    /* non-fatal — we'll just re-init next boot */
  }
  log("RTK ready — dev-command output is compressed before it reaches the model.");
  return { hasRtk: true };
}
