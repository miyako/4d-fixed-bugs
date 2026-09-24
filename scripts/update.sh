#!/usr/bin/env bash
#
# End-to-end dataset update.
#
#   ./scripts/update.sh              incremental update (frontier crawl)
#   ./scripts/update.sh --full-crawl re-probe every version candidate
#   ./scripts/update.sh --build-only skip crawling, rebuild from current data/
#
# Stages:
#   1. crawl       bugs.4d.com released (?version=) + beta (?branch=) listings
#   2. parse       HTML -> data/bugs_raw.json
#   3. sync-jp     4D-JP repos -> data/jp_notes.json
#   4. context     -> data/all_bugs_context.json + data/pending_enrichment.json
#   --- manual gate: write English prose for the pending bugs, then
#       python3 scripts/update/merge_enrichment.py data/enrichment_output.json
#   5. links       re-verify every developer.4d.com link still resolves
#   6. build       -> docs/data/{meta.json,embeddings.bin}, docs/src/beta-versions.js
#   7. cache-bust  bump ?v=N on docs/index.html asset URLs
#
# Stages 1-4 are fully deterministic and safe to re-run. The script stops at
# the enrichment gate when there is prose to write, because that step is the
# only one that needs judgement; re-run with --build-only afterwards to finish.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

CRAWL_ARGS=(--fast)
BUILD_ONLY=0
EMBED_ARGS=()

while [ $# -gt 0 ]; do
    case "$1" in
        --full-crawl) CRAWL_ARGS=(--full) ;;
        --build-only) BUILD_ONLY=1 ;;
        --force-embed) EMBED_ARGS=(--force) ;;
        -h|--help) sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "unknown option: $1" >&2; exit 2 ;;
    esac
    shift
done

step() { printf '\n\033[1m== %s\033[0m\n' "$1"; }

if [ "$BUILD_ONLY" -eq 0 ]; then
    step "1/7 Crawling bugs.4d.com"
    python3 scripts/update/crawl.py "${CRAWL_ARGS[@]}"

    step "2/7 Parsing HTML"
    python3 scripts/update/parse.py

    step "3/7 Syncing Japanese notes"
    python3 scripts/update/sync_jp.py

    step "4/7 Building enrichment context"
    python3 scripts/update/build_context.py

    PENDING=$(python3 -c "import json;print(len(json.load(open('data/pending_enrichment.json'))))")
    if [ "$PENDING" -gt 0 ]; then
        cat <<EOF

$PENDING bug(s) need an English summary written before the site can be rebuilt.

  1. Read  data/pending_enrichment.json
  2. Write [{reference, summary, commands}] to data/enrichment_output.json
  3. Run   python3 scripts/update/merge_enrichment.py data/enrichment_output.json
  4. Run   ./scripts/update.sh --build-only

EOF
        exit 0
    fi
fi

step "5/7 Checking documentation links"
python3 scripts/update/check_links.py

step "6/7 Building embeddings + client dataset"
(cd scripts && npm install --silent && node update/generate_embeddings.mjs "${EMBED_ARGS[@]}")

step "7/7 Bumping asset cache-busting version"
python3 scripts/update/bump_cache_bust.py

step "Done"
python3 - <<'EOF'
import json
state = json.load(open("data/update_state.json"))
counts = state.get("counts", {})
print(f"  bugs:         {counts.get('context', '?')}")
print(f"  enriched:     {counts.get('enriched', '?')}")
print(f"  jp notes:     {counts.get('jp_notes', '?')}")
print(f"  pages found:  {counts.get('pages_found', '?')}")
print(f"  last run:     {state.get('last_run')}")
EOF
echo
echo "Review 'git diff', then commit docs/ and data/."
