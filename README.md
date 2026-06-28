# Claude Console

Faire tourner le **vrai Claude Code CLI** dans la console d'un serveur UniSlaw.

Vous créez un serveur **Node.js** depuis le panel UniSlaw, vous le pointez sur ce
dépôt, et la console interactive du panel (xterm.js) devient un terminal Claude
Code en direct : frappes, souris, `Ctrl-C`, redimensionnement — tout est
transmis au CLI. Vous vous connectez **une seule fois** (abonnement Claude), et
la session survit aux redémarrages parce que les identifiants sont stockés sur le
volume du serveur.

> Pas de modification d'UniSlaw ni du dépôt Templates : Claude Console est juste
> le `GIT_REPO` du template générique `nodejs`.

## Déployer sur UniSlaw

1. **Panel → nouveau serveur → template « Node.js »**.
2. Variables :
   - `NODE_VERSION` : `24` (recommandé).
   - `GIT_REPO` : l'URL HTTPS de **ce dépôt** (ex. `https://github.com/<vous>/claude-console`).
3. Installer puis démarrer le serveur, et ouvrir la **console**.
4. **Premier démarrage** : Claude Code affiche son écran de connexion. Choisissez
   « Log in with Claude », ouvrez l'URL affichée, collez le code dans la console.
   C'est fait une fois pour toutes — les identifiants sont écrits sur le volume.

Le port public attribué par le panel n'est pas utilisé (Claude Code est un TUI,
il n'écoute sur rien) ; c'est attendu, comme pour le template `shell`.

## Ce que fait le lanceur (`boot.mjs`)

Le template lance `npm start` → `node boot.mjs`, qui prépare l'environnement puis
passe le PTY directement à `claude` :

- **Persistance du login** : `HOME` est pinné sur le volume (`/home/container/.claude-home`).
  Claude Code y écrit `~/.claude.json`, les identifiants OAuth, l'historique et
  l'état des projets → connexion conservée entre redémarrages et réinstallations.
- **Espace de travail** : Claude travaille dans `/home/container/workspace` (séparé
  de sa config). Vos fichiers vivent là.
- **Installation garantie (self-heal)** : Claude Code v2 est un **binaire natif
  ~224 Mo** livré via des dépendances optionnelles par plateforme (il existe une
  build **musl** pour alpine). Or une dépendance *optionnelle* qui échoue ne fait
  PAS échouer `npm install` (code 0) : un serveur peut donc démarrer sans `claude`
  utilisable. Le lanceur **vérifie** la présence du vrai binaire et, s'il manque,
  l'**installe au runtime** (une fois, conservé sur le volume) avant de lancer —
  ce qui le rend robuste sur UniSlaw comme sur n'importe quel hébergement Node.
  Lancement **direct du binaire** (jamais via le shim `.bin/claude` ou le `PATH`,
  qui peuvent manquer).
- **Toolchain autonome (git, bash, ripgrep, ssh)** : l'image runtime
  `node:24-alpine` ne fournit que busybox + node + npm — **ni git, ni bash**. Le
  conteneur d'**install** tourne lui en **root avec `apk` + réseau**, alors
  `scripts/postinstall.mjs` installe un jeu de paquets alpine **dans un préfixe
  sur le volume** (`vendor/toolchain/`, via `apk add --root`). `apk` y résout
  toutes les dépendances (libs `.so`, helpers `git-core`, bundle CA). Au runtime
  le lanceur ajoute ces dossiers à `PATH` + `LD_LIBRARY_PATH` (et règle
  `GIT_EXEC_PATH`, `GIT_SSL_CAINFO`, `SHELL`…) : `git`, `bash`, `rg`, `ssh` sont
  alors disponibles **dans** la console Claude. Ça marche parce qu'install et
  runtime partagent la même base alpine (même loader musl). Étendre avec
  `CLAUDE_CONSOLE_TOOLS` (paquets apk supplémentaires).
- **Installation garantie du binaire (rappel)** : si la toolchain échoue, Claude
  Code démarre quand même ; le shell retombe sur busybox.
- **Console toujours vivante** : quand `claude` se termine (`/exit`), le serveur
  le relance, avec un garde-fou anti-boucle de crash.

## Variables d'environnement (optionnelles)

À définir comme variables du serveur dans le panel.

| Variable | Défaut | Rôle |
|---|---|---|
| `CLAUDE_CONSOLE_WORKSPACE` | `<volume>/workspace` | Dossier de travail de Claude (mettre `/home/container` pour la racine du volume). |
| `CLAUDE_CONSOLE_HOME` | `<volume>/.claude-home` | `HOME` où sont stockés config + identifiants. |
| `CLAUDE_CONSOLE_ON_EXIT` | `relaunch` | `relaunch` \| `stop` \| `shell` à la sortie de Claude Code. |
| `CLAUDE_CONSOLE_ARGS` | _(vide)_ | Arguments ajoutés à `claude` (session interactive si vide). |
| `CLAUDE_CONSOLE_AUTO_INSTALL` | `1` | `0` désactive l'installation self-heal au runtime (hôtes sans réseau). |
| `CLAUDE_CONSOLE_TOOLS` | _(vide)_ | Paquets apk supplémentaires à provisionner dans la toolchain (ex. `nano vim jq`). À définir **avant l'installation** du serveur. |
| `ANTHROPIC_API_KEY` | _(non défini)_ | Si présent, Claude Code l'utilise (crédits API) au lieu de l'abonnement. |

## Dépannage

- **`spawn claude ENOENT` / Claude Code absent** : le binaire natif (~224 Mo,
  dépendance optionnelle) n'a pas été installé — souvent un timeout/quota disque
  pendant `npm install`. Le lanceur tente désormais une installation au runtime ;
  si elle échoue, vérifiez l'accès internet et l'espace disque du serveur, puis
  redémarrez. Forcer une réinstallation propre du serveur (qui rejoue
  `npm install`) résout aussi le souci.
- **« No suitable shell found … SHELL »** (outil Bash de Claude Code) : l'image
  alpine ne définit pas `SHELL`. Le lanceur le règle automatiquement sur le shell
  présent (`/bin/sh` busybox). Si le message persiste, votre image runtime n'a
  aucun shell POSIX.
- **`git: not found` / `bash: not found` dans la console Claude** : la toolchain
  n'a pas pu être provisionnée à l'installation. Le bandeau de démarrage indique
  `toolchain: busybox only`. Causes probables : pas de réseau/quota disque, ou
  `apk` indisponible au moment de l'install. **Réinstallez** le serveur (le
  provisioning ne tourne qu'à l'install, en root) ; au besoin réduisez
  `CLAUDE_CONSOLE_TOOLS`. Note : le provisioning suppose une image d'install
  alpine (`node:*-alpine`) avec les dépôts `main`+`community`.

## Mises à jour

Claude Code est une **dépendance** de ce dépôt (`@anthropic-ai/claude-code`).
Réinstaller le serveur depuis le panel relance `npm install` et récupère la
dernière version. L'auto-updater interne de Claude Code est désactivé
(`DISABLE_AUTOUPDATER=1`) pour éviter qu'il réécrive l'install gérée par npm.

## Développement local

```sh
npm install        # installe Claude Code + provisionne ripgrep (Linux)
npm start          # lance Claude Code dans le terminal courant
npm run check      # node --check (zéro install) — ce que rejoue la CI
```

Sur macOS / Windows, le `postinstall` ne télécharge rien (le ripgrep livré avec
Claude Code y fonctionne).

## Notes

- Cible supportée : **linux/amd64** (cible de prod UniSlaw). arm64/musl est
  best-effort pour ripgrep.
- Sécurité : les identifiants Claude vivent sur le volume du serveur. Traitez ce
  volume comme un secret ; toute personne ayant accès à la console est connectée
  à votre compte Claude.

## Release

Inspiré du système de **Bios**, adapté à un projet Node. Chaque push sur `main` :

- versionne automatiquement (`v1.0.<run_number>`, monotone — pas de marqueurs de
  commit à gérer) ;
- publie une **archive source** du lanceur (`claude-console-<version>.tar.gz` +
  `SHA256SUMS`) — pas de `node_modules`, UniSlaw fait `npm install` lui-même ;
- ne garde **qu'une seule release** : les anciennes releases/tags sont supprimées ;
- **nettoie** le dépôt : caches Actions, artifacts et vieux runs (garde les 10
  derniers). Les reruns d'un même numéro repartent propres.

Le déploiement, lui, n'utilise pas la release : le template `nodejs` clone le
HEAD de `main` (`git clone --depth 1`). La release sert de snapshot publié et
d'historique de versions.
