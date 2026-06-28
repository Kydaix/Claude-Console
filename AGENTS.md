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
- ripgrep musl : `scripts/postinstall.mjs` télécharge un `rg` **statique musl**
  dans `vendor/` (seul moment avec root + réseau + volume). Le postinstall ne
  doit **jamais** faire échouer `npm install` (toujours `exit 0`).
- Cibler `linux/amd64` (cible de prod UniSlaw). arm64 musl est best-effort.

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
