#!/bin/bash
# Hourly KRS Radar sync helper. The browser step copies the workbook (base64) to the clipboard;
# this script uploads it with the ingest key from ~/.config/krs-radar/ingest_key and restores
# whatever the user had on the clipboard before.
#   krs-sync.sh save   — stash the current clipboard
#   krs-sync.sh push   — upload the clipboard workbook, then restore the stash
set -euo pipefail

API="https://aikyzkiyfgctyklfopzy.supabase.co/functions/v1/krs-api"
DIR="$HOME/.config/krs-radar"
KEY_FILE="$DIR/ingest_key"
STASH="$DIR/clipboard.stash"
export LC_ALL=en_US.UTF-8

case "${1:-}" in
  save)
    pbpaste > "$STASH" 2>/dev/null || : > "$STASH"
    chmod 600 "$STASH"
    echo "clipboard saved"
    ;;
  push)
    tmp="$(mktemp -t krs-sync)"
    trap 'rm -f "$tmp"; if [ -f "$STASH" ]; then pbcopy < "$STASH"; rm -f "$STASH"; fi' EXIT
    pbpaste | base64 -D > "$tmp"
    if [ "$(head -c 2 "$tmp")" != "PK" ]; then
      echo "ERROR: clipboard does not hold an xlsx file" >&2
      exit 1
    fi
    curl -sS --fail-with-body -X POST "$API" \
      -H "x-ingest-key: $(cat "$KEY_FILE")" \
      -H "content-type: application/octet-stream" \
      --data-binary "@$tmp"
    echo
    ;;
  *)
    echo "usage: $0 save|push" >&2
    exit 2
    ;;
esac
