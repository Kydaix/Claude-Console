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
- ripgrep musl (défensif) : `scripts/postinstall.mjs` peut déposer un `rg`
  statique musl dans `vendor/` ; il ne doit **jamais** faire échouer `npm install`
  (toujours `exit 0`). Le binaire natif embarque déjà son propre ripgrep.
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
