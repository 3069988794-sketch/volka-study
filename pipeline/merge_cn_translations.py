"""Merge agent-produced translation shards into cn_translations.json.

Two layers, applied in order:

1. `_work/agent_translations/*.json` — bulk output. First writer wins; a later
   shard that disagrees is reported as a conflict and skipped, never silently
   overwritten.
2. `pipeline/cn_fixes.json` — curator overrides applied last, so a reviewed
   correction always beats whatever the bulk pass produced. This is the only
   layer allowed to overwrite, and it is what makes review findings durable:
   emptying the cache and re-merging reproduces the corrections.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
WORK = ROOT / "pipeline" / "_work"
CACHE = WORK / "cn_translations.json"
SHARDS = WORK / "agent_translations"
ENRICHED = WORK / "senses_enriched.json"
FIXES = ROOT / "pipeline" / "cn_fixes.json"


def load_json(path: Path, default: Any) -> Any:
    if not path.exists():
        return default
    return json.loads(path.read_text(encoding="utf-8"))


def load_shard(path: Path) -> dict[str, Any] | None:
    """Read a shard, tolerating one that is still being written.

    Translation agents write shards concurrently with this script being run, so a
    half-flushed file is expected rather than exceptional. Skip it and say so;
    the next merge picks it up.
    """
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        print(f"~ skipping {path.name}: not valid JSON yet ({exc})", file=sys.stderr)
        return None


def main() -> int:
    enriched = load_json(ENRICHED, {})
    valid_ids = {s["sense_id"] for s in enriched.get("senses", [])}
    if not valid_ids:
        print(f"! missing or invalid {ENRICHED}", file=sys.stderr)
        return 1

    cache = load_json(
        CACHE,
        {
            "_readme": "Durable Chinese translation cache. Keyed by permanent sense_id; safe to fill incrementally.",
            "translations": {},
        },
    )
    translations = cache.setdefault("translations", {})
    before = len(translations)
    merged = skipped = conflicts = 0
    conflict_rows: list[dict[str, str]] = []

    incomplete = 0
    for shard in sorted(SHARDS.glob("*.json")):
        # Skip scratch / temp files agents may leave mid-run (e.g. _a22_src_*.json).
        if shard.name.startswith("_"):
            print(f"~ skipping {shard.name}: temp/scratch file", file=sys.stderr)
            continue
        payload = load_shard(shard)
        if payload is None:
            incomplete += 1
            continue
        if not isinstance(payload, dict):
            print(f"~ skipping {shard.name}: expected object, got {type(payload).__name__}", file=sys.stderr)
            incomplete += 1
            continue
        records = payload.get("translations", payload)
        if not isinstance(records, dict):
            print(f"~ skipping {shard.name}: translations is {type(records).__name__}, not object", file=sys.stderr)
            incomplete += 1
            continue
        for sense_id, rec in records.items():
            if not isinstance(rec, dict):
                skipped += 1
                continue
            if sense_id not in valid_ids:
                skipped += 1
                continue
            gloss_cn = str(rec.get("gloss_cn") or "").strip()
            example_cn = str(rec.get("example_cn") or "").strip()
            if not gloss_cn or not example_cn:
                skipped += 1
                continue
            current = translations.get(sense_id)
            incoming = {"gloss_cn": gloss_cn, "example_cn": example_cn}
            if current and current == incoming:
                continue
            if current:
                conflicts += 1
                conflict_rows.append(
                    {
                        "sense_id": sense_id,
                        "shard": shard.name,
                        "current_gloss_cn": current.get("gloss_cn", ""),
                        "incoming_gloss_cn": incoming["gloss_cn"],
                    }
                )
                continue
            if not current:
                translations[sense_id] = incoming
                merged += 1

    fixed = 0
    fixes = load_json(FIXES, {}).get("fixes", {})
    for sense_id, rec in fixes.items():
        if sense_id not in valid_ids:
            print(f"! cn_fixes.json: unknown sense_id {sense_id}", file=sys.stderr)
            continue
        current = translations.get(sense_id, {})
        patch = {
            k: str(rec[k]).strip()
            for k in ("gloss_cn", "example_cn")
            if rec.get(k) and str(rec[k]).strip()
        }
        if not patch:
            continue
        merged_rec = {**current, **patch}
        if merged_rec != current:
            translations[sense_id] = merged_rec
            fixed += 1

    CACHE.write_text(json.dumps(cache, ensure_ascii=False, indent=1), encoding="utf-8")
    if conflict_rows:
        report = WORK / "translation_merge_conflicts.json"
        report.write_text(json.dumps(conflict_rows, ensure_ascii=False, indent=1), encoding="utf-8")
        print(f"conflict report -> {report}")
    print(f"cache before {before} / after {len(translations)}")
    print(
        f"merged {merged} / skipped {skipped} / conflicts {conflicts} / "
        f"curator fixes {fixed} / shards not ready {incomplete}"
    )
    return 1 if conflicts else 0


if __name__ == "__main__":
    raise SystemExit(main())
