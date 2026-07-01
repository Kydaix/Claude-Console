# Claude Console — notes for agents

Petit projet Node, sans dépendances de build : un lanceur qui fait tourner le
**vrai Claude Code CLI** dans la console interactive d'un serveur UniSlaw.

## Modèle de déploiement (à garder en tête avant toute modif)

- Hébergé via le template générique **`nodejs`** d'UniSlaw (dépôt `Templates`).
  On ne modifie PAS UniSlaw/Templates : ce repo est le `GIT_REPO` du serveur.
- Le template fait `npm install --omit=dev` puis `npm start` (argv exec, **pas
  de shell**) en uid 1000, workdir `/home/container`, avec un **PTY interactif**
  (xterm.js : frappes, souris, Ctrl-C, SIGWINCH).
- **Install et runtime sont deux conteneurs séparés** (`node:24-alpine`) qui ne
  partagent que le **volume**. Donc : pas d'`apk add` au runtime, et tout ce qui
  doit persister (binaire `rg`, identifiants, config) vit sur le volume.

## Invariants

- `npm start` → `boot.mjs`. `boot.mjs` reste **dep-free** (Node pur, ESM).
- `HOME` est pinné sur le volume (`.claude-home`) → le login (abonnement) survit
  aux redémarrages. Ne jamais écrire d'identifiants hors du volume.
- **Claude Code v2 = binaire natif ~224 Mo** via deps optionnelles par plateforme
  (build `linux-x64-musl` pour alpine). Une dep *optionnelle* qui échoue ne casse
  pas `npm install` (exit 0) → `boot.mjs` doit **vérifier** le vrai binaire
  (`node_modules/@anthropic-ai/claude-code/bin/claude.exe`, taille ≥ ~5 Mo, sinon
  c'est le stub) et l'**installer au runtime** s'il manque. Lancer le binaire en
  **direct**, jamais via `.bin/claude`/PATH (peut manquer ou être un lien mort).
- **Toolchain sur le volume, SANS root** : l'image runtime alpine n'a ni git ni
  bash, et l'outil Bash de Claude Code exige un **vrai bash** (busybox sh refusé).
  Sur la cible, rien ne tourne en root (juste `npm start` en uid 1000), donc
  `apk add` (qui chown root) est exclu. `scripts/toolchain.mjs` :
  `apk fetch --recursive` (télécharge la fermeture de deps en `.apk`, sans root) →
  extracteur `.apk` dep-free (`extractApk` : `gunzipSync` gère les membres gzip
  concaténés, lecteur ustar maison qui saute pax/control, pas de `chown`) →
  déballe dans `.toolchain/` à la racine du volume (créé au runtime en uid 1000 ;
  PAS `vendor/`, souvent cloné en root → non inscriptible). `boot.mjs` câble `PATH`/`LD_LIBRARY_PATH`/
  `GIT_EXEC_PATH`/`GIT_SSL_CAINFO`/`SHELL`. Marche car install et runtime partagent
  la base `node:*-alpine` (même loader musl). **Fallback bash statique** (1 fichier,
  zéro dep) si `apk fetch` échoue → le shell marche toujours. Idempotent via le
  marqueur `.toolchain/.provisioned` (pas de marqueur ⇒ on réessaie au boot).
- `ensureToolchain` est appelé par `boot.mjs` (runtime, uid 1000) **et**
  `postinstall.mjs` (au cas où un hôte installe en root). Ne doit **jamais** faire
  échouer `npm install` (postinstall `exit 0`).
- L'extracteur est validé sur de vrais `.apk` ; ne pas le « simplifier » avec
  `tar`/`gunzip` shell (busybox tar gère mal les `.apk` multi-membres).
- **RTK** (`scripts/rtk.mjs`, **activé par défaut**, opt-out `CLAUDE_CONSOLE_RTK=0`) :
  [rtk-ai/rtk](https://github.com/rtk-ai/rtk), binaire **statique musl** unique
  (`rtk-x86_64-unknown-linux-musl.tar.gz` = un seul `rtk` à la racine du tar →
  réutilise `extractApk`), déposé dans `.toolchain/usr/bin` (déjà sur le `PATH`).
  Fait **dans `boot.mjs`, pas `postinstall`** : son hook doit atterrir dans le
  `~/.claude` du `HOME` épinglé (n'existe qu'au runtime), et il câble le binaire
  sur `childEnv.PATH` de la session lancée. `rtk init -g --auto-patch` (une fois,
  marqueur `.toolchain/.rtk-installed`) écrit le hook Bash `PreToolUse`
  (`rtk hook claude`) dans `settings.json` → **le hook appelle `rtk` par le
  `PATH`**, donc ne jamais retirer `usr/bin` du `PATH`. Jamais fatal (dégrade en
  « non installé »). musl = amd64 ; arm64 best-effort (build glibc amont).
- Cibler `linux/amd64`. arm64 géré par `apk` natif + asset bash-static aarch64.

## Vérifs locales

```sh
npm run check     # node --check sur boot.mjs + postinstall.mjs (zéro install)
```

## Release & nettoyage

Système inspiré de **Bios**, adapté Node (`.github/workflows/release.yml`).
Chaque push sur `main` :
- version auto `v1.0.<run_number>` (monotone, aucun marqueur de commit) ;
- release = **archive source** (`git archive` du HEAD, sans `node_modules`) +
  `SHA256SUMS` ; rerun idempotent (`gh release delete --cleanup-tag` d'abord) ;
- **une seule release conservée** (les anciennes releases/tags sont purgées) ;
- nettoyage best-effort : caches, artifacts, runs (garde les 10 derniers) — ces
  étapes finissent par `exit 0` et ne doivent jamais casser la release.

Le job `check` (`npm run check`, zéro install) tourne aussi sur les PR ; le job
`release` ne tourne que sur `main`.
