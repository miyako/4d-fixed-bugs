#!/usr/bin/env bash
#
# 4D Bugs Crawler - Phase 1: HTML discovery + fetch
#
# Fetches https://bugs.4d.com/fixedbugslist?version=<VERSION> for every
# candidate version string in the known 4D version-numbering scheme, and
# saves each response HTML to disk (exists/ if the version is valid,
# notfound/ if bugs.4d.com returns its "no such version" error page).
#
# KEY DISCOVERY: bugs.4d.com does NOT rate-limit requests. The 403/blocked
# responses seen in early attempts were caused entirely by curl/wget's
# default User-Agent being rejected -- NOT by request frequency. Adding a
# normal browser User-Agent header resolves this completely; 775 rapid
# sequential requests all returned HTTP 200 with no throttling or backoff
# needed. Do NOT add artificial sleep/delay -- it is unnecessary.
#
# Invalid versions do not 404; they return HTTP 200 with a page containing
# `<div class="standard_error">`. That marker is what distinguishes a real
# "not found" from a valid version page (which contains `<table class="list">`
# rows of bugs, or is a valid version with zero bugs).
#
# Version scheme (see README/session notes for full explanation):
#   - Major only:            18, 19, 20, 21, 22 ...
#   - Feature release:       <major>_r<N>        (N starts at 2, e.g. 20_r10)
#   - Feature release + HF:  <major>_r<N>_hf<M>  (M starts at 1)
#   - Minor/patch release:   <major>.<N>          (N starts at 1, no .0)
#   - Minor release + HF:    <major>.<N>_hf<M>
#
# Usage:
#   ./crawl_4d_bugs.sh
#
# Output:
#   exists/<version>.html    -- raw HTML for valid versions
#   notfound/<version>.html  -- raw HTML for the "standard_error" page (kept
#                                 for auditing/debugging, small files)
#   crawl_log.tsv            -- tab-separated log: version, status, http_code,
#                                bytes, bug_count (bug_count is a quick grep
#                                count of `<th class="title 4D">` rows, 0 for
#                                notfound pages)

set -uo pipefail

BASE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXISTS_DIR="$BASE_DIR/exists"
NOTFOUND_DIR="$BASE_DIR/notfound"
LOG_FILE="$BASE_DIR/crawl_log.tsv"

mkdir -p "$EXISTS_DIR" "$NOTFOUND_DIR"

UA="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
BASE_URL="https://bugs.4d.com/fixedbugslist?version="

# Initialize log with header if it doesn't already exist
if [ ! -f "$LOG_FILE" ]; then
    printf "version\tstatus\thttp_code\tbytes\tbug_count\n" > "$LOG_FILE"
fi

# Build the full candidate list. Ranges are intentionally generous --
# out-of-range candidates simply come back as "notfound" and cost one
# cheap HTTP request each; this is far simpler and more robust than trying
# to predict the exact ceiling per major version up front.
build_candidates() {
    local out=()
    for major in 18 19 20 21 22; do
        # Major-only (== "20" style, no release token)
        out+=("$major")

        # Feature releases r2..r14, each with optional hf1..hf6
        for r in $(seq 2 14); do
            out+=("${major}_r${r}")
            for hf in $(seq 1 6); do
                out+=("${major}_r${r}_hf${hf}")
            done
        done

        # Minor/patch releases .1...9, each with optional hf1..hf6
        for m in $(seq 1 9); do
            out+=("${major}.${m}")
            for hf in $(seq 1 6); do
                out+=("${major}.${m}_hf${hf}")
            done
        done
    done
    printf '%s\n' "${out[@]}"
}

already_done() {
    # Skip versions we've already logged (resumability across runs)
    local v="$1"
    grep -qP "^${v}\t" "$LOG_FILE" 2>/dev/null
}

fetch_one() {
    local version="$1"
    local url="${BASE_URL}${version}"
    local tmp_file
    tmp_file="$(mktemp)"

    local http_code
    http_code=$(curl -s -o "$tmp_file" -w "%{http_code}" \
        -H "User-Agent: $UA" \
        --max-time 30 \
        "$url")

    local bytes
    bytes=$(wc -c < "$tmp_file" | tr -d ' ')

    if grep -q 'class="standard_error"' "$tmp_file"; then
        mv "$tmp_file" "$NOTFOUND_DIR/${version}.html"
        printf "%s\tnotfound\t%s\t%s\t0\n" "$version" "$http_code" "$bytes" >> "$LOG_FILE"
        echo "[notfound] $version"
    else
        local bug_count
        bug_count=$(grep -o 'class="title 4D"' "$tmp_file" | wc -l | tr -d ' ')
        mv "$tmp_file" "$EXISTS_DIR/${version}.html"
        printf "%s\tfound\t%s\t%s\t%s\n" "$version" "$http_code" "$bytes" "$bug_count" >> "$LOG_FILE"
        echo "[found]    $version  ($bug_count bugs, $bytes bytes)"
    fi
}

main() {
    local candidates
    mapfile -t candidates < <(build_candidates)
    echo "Total candidates: ${#candidates[@]}"

    for version in "${candidates[@]}"; do
        if already_done "$version"; then
            continue
        fi
        fetch_one "$version"
    done

    echo "Done. See $LOG_FILE for the full crawl summary."
}

main "$@"
