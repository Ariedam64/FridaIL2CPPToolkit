"""Pre-render every Dofus map to dofus-app/data/maps-preview/<mapId>.png.

Multiprocessing worker pool (N = cpu_count - 1). Maps are grouped by
their source mapdata bundle so each worker can amortise UnityPy's
expensive bundle-load + sprite-decode across ~30 nearby maps with a
warm cache. RAM stays bounded because each worker clears its caches
between bundles.

Progress is written atomically to data/prerender-progress.json after
every completed bundle — the server exposes it at /api/prerender-progress
so the UI can poll without contention. Existing PNGs are skipped, so
re-runs only cover the gaps (resumable).

Usage:
  python dofus-app/scripts/prerender-all-maps.py            # all maps, all cores
  python dofus-app/scripts/prerender-all-maps.py --workers 4
  python dofus-app/scripts/prerender-all-maps.py --limit 50  # smoke test
  python dofus-app/scripts/prerender-all-maps.py --force     # re-render existing
"""
import sys, json, time, os, signal, argparse, importlib.util, traceback, multiprocessing as mp
from pathlib import Path
from collections import defaultdict

APP = Path(__file__).resolve().parent.parent
DATA_DIR = APP / "data"
OUT_DIR = DATA_DIR / "maps-preview"
INDEX = DATA_DIR / "mapdata-bundle-index.json"
PROGRESS_FILE = DATA_DIR / "prerender-progress.json"
RENDERER_PATH = Path(__file__).resolve().parent / "render-map-offline.py"


def _atomic_write_json(path: Path, data: dict):
    """Write JSON to a tmp file then rename — readers (the HTTP server) never
    see a half-written file. Posix rename is atomic; on Windows we use the
    same path because os.replace is also atomic since Python 3.3."""
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, indent=2), encoding="utf-8")
    os.replace(tmp, path)


# -----------------------------------------------------------------------------
# Worker — runs in a child process. Imports the renderer once at first call,
# then loops through assigned mapIds with a warm UnityPy cache.
# -----------------------------------------------------------------------------

_renderer = None


def _get_renderer():
    """Lazy import — render-map-offline.py has a hyphen so the standard
    import machinery can't load it; use importlib.util once per worker."""
    global _renderer
    if _renderer is None:
        spec = importlib.util.spec_from_file_location("rmo", str(RENDERER_PATH))
        _renderer = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(_renderer)
    return _renderer


def render_bundle(args):
    """Process one mapdata bundle's worth of mapIds. Returns
    (bundle_name, [(mapId, status, elapsed_ms), ...]).

    The renderer's sprite cache is byte-budgeted (LRU, ~1 GB/worker via
    SPRITE_CACHE_MAX_BYTES in render-map-offline.py) so we don't clear
    between maps — sprite reuse across nearby maps in the same bundle
    is the main win. We do clear at start and end so a worker that
    cycles through bundles doesn't carry stale state forward."""
    bundle_name, map_ids, force = args
    rmo = _get_renderer()
    rmo._env_cache.clear()
    rmo._cache_clear()
    out = []
    for mid in map_ids:
        out_path = OUT_DIR / f"{mid}.png"
        if out_path.exists() and not force:
            out.append((mid, "skip", 0))
            continue
        t0 = time.time()
        try:
            r = rmo.render(mid, out_path)
            dt = int((time.time() - t0) * 1000)
            if r.get("ok"):
                out.append((mid, "ok", dt))
            else:
                out.append((mid, f"err:{str(r.get('reason', '?'))[:80]}", dt))
        except Exception as e:
            out.append((mid, f"exc:{type(e).__name__}:{str(e)[:80]}", int((time.time() - t0) * 1000)))
    rmo._env_cache.clear()
    rmo._cache_clear()
    return bundle_name, out


# -----------------------------------------------------------------------------
# Coordinator — runs in the parent. Submits bundles to the pool, collates
# results into the progress JSON.
# -----------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--workers", type=int, default=max(1, mp.cpu_count() - 1))
    ap.add_argument("--limit",   type=int, default=0, help="cap total maps (smoke test)")
    ap.add_argument("--force",   action="store_true", help="re-render maps that already have a PNG")
    args = ap.parse_args()

    if not INDEX.exists():
        print(f"missing {INDEX} — run build-mapdata-bundle-index.py first", file=sys.stderr)
        sys.exit(1)

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    idx = json.loads(INDEX.read_text(encoding="utf-8"))
    by_bundle: dict[str, list[int]] = defaultdict(list)
    for mid_str, bundle in idx.items():
        by_bundle[bundle].append(int(mid_str))

    # Optional limit: take whole bundles, smallest first, until we hit
    # the cap. Whole bundles preserve cache warmth; "smallest first"
    # spreads the smoke test across enough bundles to actually exercise
    # multiprocessing parallelism (the previous "biggest first +
    # truncate" packed everything into a single bundle, so only one
    # worker had any work to do).
    if args.limit > 0:
        kept = 0
        trimmed = {}
        for b, ids in sorted(by_bundle.items(), key=lambda kv: len(kv[1])):
            if kept >= args.limit:
                break
            trimmed[b] = ids
            kept += len(ids)
        by_bundle = trimmed

    # Largest bundles first — better load balancing across workers (the
    # short tail at the end won't leave one worker doing a 60-map bundle
    # while everyone else is idle).
    bundle_jobs = sorted(by_bundle.items(), key=lambda kv: -len(kv[1]))
    total_maps = sum(len(v) for v in by_bundle.values())

    state = {
        "total": total_maps,
        "bundles_total": len(bundle_jobs),
        "bundles_done": 0,
        "done": 0,
        "skipped": 0,
        "failed": 0,
        "workers": args.workers,
        "started_at": time.time(),
        "updated_at": time.time(),
        "finished_at": None,
        "rate_per_sec": 0.0,
        "eta_seconds": None,
        "recent_failures": [],   # last ~20 (mapId, status)
        "current_bundles": [],   # bundle names actively being rendered (best-effort)
    }
    _atomic_write_json(PROGRESS_FILE, state)
    print(f"[prerender] {total_maps} maps across {len(bundle_jobs)} bundles  · workers={args.workers}  · force={args.force}")

    def update_state(result):
        bundle_name, results = result
        for mid, status, dt in results:
            if status == "ok":   state["done"] += 1
            elif status == "skip": state["skipped"] += 1
            else:
                state["failed"] += 1
                state["recent_failures"].append({"mapId": mid, "status": status})
        state["recent_failures"] = state["recent_failures"][-20:]
        state["bundles_done"] += 1
        state["updated_at"] = time.time()
        # Rate uses processed (rendered + skipped) — failed maps are also
        # progress in the "we attempted them" sense; include in numerator.
        elapsed = state["updated_at"] - state["started_at"]
        processed = state["done"] + state["skipped"] + state["failed"]
        if elapsed > 0:
            state["rate_per_sec"] = round(processed / elapsed, 2)
        remaining = total_maps - processed
        if state["rate_per_sec"] > 0:
            state["eta_seconds"] = int(remaining / state["rate_per_sec"])
        _atomic_write_json(PROGRESS_FILE, state)
        ok_count = sum(1 for _, s, _ in results if s == "ok")
        print(f"[prerender] {bundle_name}: +{ok_count}/{len(results)}  · "
              f"total {state['done']}/{total_maps}  · "
              f"{state['rate_per_sec']}/s  · eta {state['eta_seconds']}s")

    # SIGINT cleanly stops the pool; partial progress is preserved on disk.
    def handle_sigint(*_):
        print("\n[prerender] SIGINT — finishing in-flight bundles, then exiting…")
        pool.terminate()
        sys.exit(130)
    signal.signal(signal.SIGINT, handle_sigint)

    with mp.Pool(args.workers) as pool:
        async_results = [
            pool.apply_async(render_bundle, ((b, mids, args.force),), callback=update_state)
            for b, mids in bundle_jobs
        ]
        pool.close()
        # Wait, surfacing exceptions if any worker dies hard.
        for ar in async_results:
            try:
                ar.get()
            except Exception as e:
                print(f"[prerender] worker error: {e}\n{traceback.format_exc()}", file=sys.stderr)
        pool.join()

    state["finished_at"] = time.time()
    state["updated_at"] = state["finished_at"]
    _atomic_write_json(PROGRESS_FILE, state)
    total_elapsed = state["finished_at"] - state["started_at"]
    print(f"[prerender] done — rendered {state['done']}, skipped {state['skipped']}, "
          f"failed {state['failed']} in {total_elapsed:.0f}s ({state['rate_per_sec']}/s)")


if __name__ == "__main__":
    main()
