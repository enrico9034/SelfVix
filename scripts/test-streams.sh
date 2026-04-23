#!/usr/bin/env bash
# Smoke-test a SelfVix addon (local or remote) across content types.
#
# Usage:
#   ./scripts/test-streams.sh                                # default: http://127.0.0.1:7000
#   PORT=7020 ./scripts/test-streams.sh                      # local on custom port
#   BASE=https://selfvix.example.com ./scripts/test-streams.sh
#   ./scripts/test-streams.sh https://selfvix.example.com    # URL as positional arg
#   ./scripts/test-streams.sh --base https://selfvix.example.com
#
# BASE/positional arg takes precedence over PORT. If neither is set, falls back
# to http://127.0.0.1:${PORT:-7000} (local dev mode).

set -u

# ── Parse args ──
ARG_BASE=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --base) ARG_BASE="$2"; shift 2 ;;
    --base=*) ARG_BASE="${1#*=}"; shift ;;
    http://*|https://*) ARG_BASE="$1"; shift ;;
    -h|--help)
      sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) echo "Unknown arg: $1" >&2; exit 2 ;;
  esac
done

if [ -n "$ARG_BASE" ]; then
  BASE="${ARG_BASE%/}"
elif [ -n "${BASE:-}" ]; then
  BASE="${BASE%/}"
else
  PORT="${PORT:-7000}"
  BASE="http://127.0.0.1:${PORT}"
fi

echo "Target: ${BASE}"
echo

# type  | id                        | description
CASES=(
  "movie  | tt15398776               | Movie IMDb (Oppenheimer) → VixSrc only, AU 404"
  "movie  | tmdb:872585              | Movie TMDB (Oppenheimer) → VixSrc only, AU 404"
  "series | tt0944947:1:1            | Series IMDb (Game of Thrones S1E1) → VixSrc only, AU 404"
  "series | tmdb:1399:1:1            | Series TMDB (Game of Thrones S1E1) → VixSrc only, AU 404"
  "series | kitsu:49240:9            | Anime Kitsu (Frieren S2 E9) → AU ITA+SUB"
  "series | tt22248376:1:1           | Anime IMDb (Frieren S1E1) → AU via mapping + VixSrc"
  "series | tt22248376:2:10          | Anime IMDb (Frieren S2E10) → AU via mapping + VixSrc"
  "movie  | tt10293406               | Anime movie IMDb (Demon Slayer Mugen Train) → AU + VixSrc"
  "series | tt21209876:1:1           | Anime IMDb (Dandadan S1E1) → AU + VixSrc"
  "series | kitsu:50423:1            | Anime Kitsu (Jack of all Trades ep1) → AU only"
)

pass=0
fail=0
for case in "${CASES[@]}"; do
  type="$(echo "$case" | awk -F'|' '{gsub(/ +$/,"",$1); gsub(/^ +/,"",$1); print $1}')"
  id="$(echo "$case" | awk -F'|' '{gsub(/ +$/,"",$2); gsub(/^ +/,"",$2); print $2}')"
  desc="$(echo "$case" | awk -F'|' '{gsub(/ +$/,"",$3); gsub(/^ +/,"",$3); print $3}')"

  url="${BASE}/stream/${type}/${id}.json"
  start=$(date +%s%N)
  resp=$(curl -sS -m 30 "$url" 2>&1)
  rc=$?
  elapsed_ms=$(( ($(date +%s%N) - start) / 1000000 ))

  count=$(echo "$resp" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{let j=JSON.parse(d);console.log(Array.isArray(j.streams)?j.streams.length:0)}catch{console.log(-1)}})' 2>/dev/null)
  names=$(echo "$resp" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{let j=JSON.parse(d);console.log((j.streams||[]).map(s=>s.name+" · "+s.title).join(" | "))}catch{console.log("")}})' 2>/dev/null)

  if [ "$rc" -ne 0 ] || [ "$count" = "-1" ]; then
    echo "❌ ${type} ${id} (${elapsed_ms}ms)"
    echo "   ${desc}"
    echo "   err: ${resp:0:200}"
    fail=$((fail+1))
  else
    icon=$([ "$count" -gt 0 ] && echo "✅" || echo "⚠️ ")
    echo "$icon ${type} ${id} → ${count} streams (${elapsed_ms}ms)"
    echo "   ${desc}"
    [ -n "$names" ] && echo "   streams: ${names}"
    if [ "$count" -gt 0 ]; then pass=$((pass+1)); else fail=$((fail+1)); fi
  fi
  echo
done

echo "────────────────────────────"
echo "Passed: $pass   Failed/Empty: $fail"
[ "$fail" -eq 0 ]
