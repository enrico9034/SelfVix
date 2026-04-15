#!/usr/bin/env python3
"""Benchmark time-to-first-byte of the SelfVix HLS segment proxy.

Pure stdlib — no pip deps. Runs the full chain: stream list → master
playlist → media playlist → first segment → N iterations of TTFB/total.

Usage:
    ./scripts/bench.py --base https://tuo-dominio
    ./scripts/bench.py --base https://tuo-dominio \
        --id kitsu:46474:1 --type series --iterations 10

    # Benchmark any URL directly (skip the stream-list resolution):
    ./scripts/bench.py --segment-url '<full segment url>' -n 5
"""

from __future__ import annotations
import argparse
import json
import ssl
import sys
import time
import urllib.request
from statistics import mean, median
from urllib.error import HTTPError, URLError

DEFAULT_BASE = "https://tuo-dominio"
DEFAULT_TYPE = "series"
DEFAULT_ID = "kitsu:46474:1"  # Frieren S1E1
TIMEOUT = 30


def http_get(url: str, *, timeout: int = TIMEOUT) -> tuple[int, bytes, dict]:
    ctx = ssl.create_default_context()
    req = urllib.request.Request(url, headers={"User-Agent": "bench.py/1.0"})
    with urllib.request.urlopen(req, timeout=timeout, context=ctx) as r:
        return r.status, r.read(), dict(r.headers)


def resolve_segment_url(base: str, stype: str, sid: str, stream_index: int) -> str:
    # 1) Stream list
    list_url = f"{base.rstrip('/')}/stream/{stype}/{sid}.json"
    print(f"[1/3] GET {list_url}")
    status, body, _ = http_get(list_url)
    if status != 200:
        raise RuntimeError(f"stream list returned HTTP {status}")
    data = json.loads(body)
    streams = data.get("streams") or []
    if not streams:
        raise RuntimeError(f"no streams returned for {stype}/{sid}")
    if stream_index >= len(streams):
        raise RuntimeError(f"only {len(streams)} streams, asked index {stream_index}")
    master_url = streams[stream_index]["url"]
    print(f"      → {len(streams)} stream(s), picked [{stream_index}]: {streams[stream_index].get('title','?')}")

    # 2) Master → first variant
    print(f"[2/3] GET master manifest")
    _, master, _ = http_get(master_url)
    media_url = next(
        (ln.strip() for ln in master.decode("utf-8", errors="replace").splitlines()
         if ln.strip() and not ln.startswith("#")),
        None,
    )
    if not media_url:
        raise RuntimeError("master manifest has no variant URL")

    # 3) Media → first segment
    print(f"[3/3] GET media playlist")
    _, media, _ = http_get(media_url)
    segment_url = next(
        (ln.strip() for ln in media.decode("utf-8", errors="replace").splitlines()
         if ln.strip() and not ln.startswith("#")),
        None,
    )
    if not segment_url:
        raise RuntimeError("media playlist has no segment URL")
    return segment_url


def bench_segment(url: str, iterations: int) -> None:
    ttfbs: list[float] = []
    totals: list[float] = []
    sizes: list[int] = []

    print()
    print(f"Benchmarking: {url[:110]}{'…' if len(url) > 110 else ''}")
    print(f"Iterations: {iterations}")
    print()
    print(f"{'#':<4}{'TTFB(ms)':<12}{'Total(ms)':<12}{'Size(KB)':<12}{'Speed(MB/s)':<12}")
    print("─" * 60)

    ctx = ssl.create_default_context()
    for i in range(1, iterations + 1):
        req = urllib.request.Request(url, headers={"User-Agent": "bench.py/1.0"})
        t_start = time.perf_counter()
        t_first: float | None = None
        total_bytes = 0
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT, context=ctx) as r:
                # First read = TTFB
                chunk = r.read(1)
                if chunk:
                    t_first = time.perf_counter()
                    total_bytes += len(chunk)
                # Drain
                while True:
                    buf = r.read(65536)
                    if not buf:
                        break
                    total_bytes += len(buf)
        except (HTTPError, URLError, TimeoutError) as e:
            print(f"{i:<4}ERROR: {e}")
            continue

        t_end = time.perf_counter()
        ttfb_ms = (t_first - t_start) * 1000 if t_first else (t_end - t_start) * 1000
        total_ms = (t_end - t_start) * 1000
        size_kb = total_bytes / 1024
        speed_mbs = (total_bytes / 1_048_576) / (t_end - t_start) if t_end > t_start else 0

        print(f"{i:<4}{ttfb_ms:<12.0f}{total_ms:<12.0f}{size_kb:<12.1f}{speed_mbs:<12.2f}")
        ttfbs.append(ttfb_ms)
        totals.append(total_ms)
        sizes.append(total_bytes)

    if not ttfbs:
        print("\nNo successful runs.")
        sys.exit(1)

    print()
    print("────────────── SUMMARY ──────────────")
    print(f"TTFB   min={min(ttfbs):6.0f}ms  avg={mean(ttfbs):6.0f}ms  "
          f"median={median(ttfbs):6.0f}ms  max={max(ttfbs):6.0f}ms")
    print(f"Total  min={min(totals):6.0f}ms  avg={mean(totals):6.0f}ms  "
          f"median={median(totals):6.0f}ms  max={max(totals):6.0f}ms")
    ratio = mean(ttfbs) / mean(totals) if totals else 0
    print(f"TTFB / Total ratio: {ratio:.0%}  "
          f"({'streaming ✅' if ratio < 0.5 else 'buffering whole segment ❌'})")
    print(f"Segment size: {mean(sizes)/1024:.0f} KB")


def main() -> None:
    ap = argparse.ArgumentParser(description="Benchmark SelfVix HLS segment proxy.")
    ap.add_argument("--base", default=DEFAULT_BASE, help="addon base URL")
    ap.add_argument("--type", default=DEFAULT_TYPE, help="stremio type (series/movie)")
    ap.add_argument("--id", default=DEFAULT_ID, help="stremio id (e.g. kitsu:46474:1)")
    ap.add_argument("--stream-index", type=int, default=0,
                    help="which stream from the list (default 0 = first)")
    ap.add_argument("--segment-url", help="skip resolution, benchmark this URL")
    ap.add_argument("-n", "--iterations", type=int, default=5)
    args = ap.parse_args()

    if args.segment_url:
        url = args.segment_url
    else:
        try:
            url = resolve_segment_url(args.base, args.type, args.id, args.stream_index)
        except Exception as e:
            print(f"Failed to resolve segment URL: {e}", file=sys.stderr)
            sys.exit(2)

    bench_segment(url, args.iterations)


if __name__ == "__main__":
    main()
