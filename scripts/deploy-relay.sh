#!/usr/bin/env bash
#
# Deploys the relay to a PINNED, detached git worktree that nothing else edits,
# so development in the main checkout can never disturb a live broadcast
# (issue #59). The systemd unit runs from the deploy directory, not from the
# working copy.
#
#   npm run relay:deploy              # deploy origin/main
#   npm run relay:deploy -- <ref>     # deploy a specific branch/tag/sha
#
# Idempotent: safe to re-run. Refuses to touch anything while the relay is
# actually broadcasting.
#
# The worktree is DETACHED on purpose. A worktree checked out on `main` would
# make `git checkout main` fail in the development copy ("already checked out"),
# and a deploy is a pinned commit anyway, not a moving branch.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEPLOY_DIR="${RELAY_DEPLOY_DIR:-$HOME/relay-deploy}"
REF="${1:-origin/main}"
SERVICE="pesisselostaja-relay.service"

# Gitignored state the relay needs at runtime. A fresh worktree has none of it,
# and it must NOT be duplicated: the TTS cache, the resume state and the Piper
# voices are shared with the development copy on purpose — a second copy would
# start with a cold cache (re-synthesis costs ElevenLabs characters) and would
# lose an interrupted match's progress.
LINKED_PATHS=(
  "apps/broadcast/voices"
  "apps/broadcast/run"
  "apps/broadcast/.env.relay"
)

log() { printf '  %s\n' "$*"; }

# --- 1. Never swap code under a live broadcast -------------------------------
if systemctl --user is-active --quiet "$SERVICE"; then
  echo "VIRHE: $SERVICE on ajossa." >&2
  echo "Deployta ei tehdä kesken lähetyksen — se on juuri se, mitä issue #59 estää." >&2
  echo "Pysäytä palvelu ensin, jos ottelu on todella ohi." >&2
  exit 1
fi

echo "Relay-deploy → $DEPLOY_DIR"

# --- 2. Create or update the pinned worktree ---------------------------------
git -C "$REPO_ROOT" fetch --quiet origin || log "VAROITUS: fetch epäonnistui, käytetään paikallisia refejä"

if [ -d "$DEPLOY_DIR/.git" ] || [ -f "$DEPLOY_DIR/.git" ]; then
  git -C "$DEPLOY_DIR" checkout --quiet --detach "$REF"
  log "worktree päivitetty"
else
  git -C "$REPO_ROOT" worktree add --quiet --detach "$DEPLOY_DIR" "$REF"
  log "worktree luotu"
fi

# --- 3. Link the runtime state instead of duplicating it ---------------------
for rel in "${LINKED_PATHS[@]}"; do
  src="$REPO_ROOT/$rel"
  dst="$DEPLOY_DIR/$rel"
  if [ ! -e "$src" ]; then
    log "OHITETTU $rel (ei ole kehityskopiossa)"
    continue
  fi
  # A real file/dir here would mean the worktree started tracking it — refuse
  # rather than silently deleting whatever is in the way.
  if [ -e "$dst" ] && [ ! -L "$dst" ]; then
    echo "VIRHE: $dst on olemassa eikä ole symlink — selvitä käsin." >&2
    exit 1
  fi
  mkdir -p "$(dirname "$dst")"
  ln -sfn "$src" "$dst"
  log "linkki $rel → kehityskopio"
done

# --- 4. Dependencies ---------------------------------------------------------
# npm ci, not install: the deploy must match package-lock.json exactly and must
# never silently resolve a different version than the one that was tested.
( cd "$DEPLOY_DIR" && npm ci --silent )
log "riippuvuudet asennettu (npm ci)"

# --- 5. Report exactly what is deployed --------------------------------------
sha="$(git -C "$DEPLOY_DIR" rev-parse HEAD)"
subject="$(git -C "$DEPLOY_DIR" log -1 --format=%s)"
echo
echo "Deployattu: ${sha:0:12}  $subject"
echo "Palvelu ajaa tästä hakemistosta: $DEPLOY_DIR"
echo
echo "Seuraavaksi:  systemctl --user start $SERVICE"
