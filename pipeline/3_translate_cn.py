"""3_translate_cn.py - merge Chinese translations and prepare missing batches.

This stage does not invent translations by heuristic. It merges trusted sources:

- data/cn_seed.json: the 63 usable Chinese glosses rescued from the legacy data
- pipeline/_work/cn_translations.json: durable translation cache keyed by sense_id

When coverage is incomplete, it writes a precise gap report and optional JSON batch
files for LLM/API translation. Final data/senses.json is written only at 100% Chinese
coverage; --allow-missing only makes the diagnostic run exit successfully.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from copy import deepcopy
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
WORK = ROOT / "pipeline" / "_work"
SRC = WORK / "senses_enriched.json"
SEED = ROOT / "data" / "cn_seed.json"
CACHE = WORK / "cn_translations.json"
PARTIAL = WORK / "senses_cn_partial.json"
GAPS = WORK / "translation_gaps.json"
BATCH_DIR = WORK / "cn_batches"
FINAL = ROOT / "data" / "senses.json"
TRAILING_DOTS = re.compile(r"[.\s]+$")


def load_json(path: Path, default: Any) -> Any:
    if not path.exists():
        return default
    return json.loads(path.read_text(encoding="utf-8"))


def dump_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8")


def seed_key(sense: dict) -> str:
    return "|".join(
        [
            sense["headword"],
            sense["pos"],
            sense["level"],
            normalize_gloss(sense["gloss_en"]),
        ]
    )


def normalize_gloss(gloss: str) -> str:
    text = gloss.replace("’", "'").replace("‘", "'")
    text = re.sub(r"\s+([,.;:?!])", r"\1", text.strip().lower())
    return TRAILING_DOTS.sub("", text)


def normalize_seed_key(key: str) -> str:
    headword, pos, level, gloss = key.split("|", 3)
    return "|".join([headword, pos, level, normalize_gloss(gloss)])


def normalize_cache(raw: Any) -> dict[str, dict[str, str]]:
    """Accept either {sense_id: {...}} or {"translations": {...}}."""
    if not raw:
        return {}
    translations = raw.get("translations", raw) if isinstance(raw, dict) else {}
    out: dict[str, dict[str, str]] = {}
    for sense_id, rec in translations.items():
        if not isinstance(rec, dict):
            continue
        out[sense_id] = {
            "gloss_cn": str(rec.get("gloss_cn") or "").strip(),
            "example_cn": str(rec.get("example_cn") or "").strip(),
        }
    return out


def gap_for(sense: dict, missing: list[str]) -> dict:
    return {
        "sense_id": sense["sense_id"],
        "headword": sense["headword"],
        "level": sense["level"],
        "priority": sense.get("priority", ""),
        "freq_rank": sense.get("freq_rank", 999999),
        "missing": missing,
        "gloss_en": sense["gloss_en"],
        "example_en": sense["example_en"],
    }


def apply_cn_sources(
    senses: list[dict], seeds: dict[str, str], cache: dict[str, dict[str, str]]
) -> tuple[list[dict], list[dict]]:
    normalized_seeds = {normalize_seed_key(k): v for k, v in seeds.items()}
    merged: list[dict] = []
    gaps: list[dict] = []
    for sense in senses:
        out = deepcopy(sense)
        cached = cache.get(sense["sense_id"], {})
        gloss_cn = (cached.get("gloss_cn") or normalized_seeds.get(seed_key(sense)) or "").strip()
        example_cn = (cached.get("example_cn") or "").strip()
        out["gloss_cn"] = gloss_cn
        out["example_cn"] = example_cn
        missing = [
            field
            for field, value in (("gloss_cn", gloss_cn), ("example_cn", example_cn))
            if not value
        ]
        if missing:
            gaps.append(gap_for(out, missing))
        merged.append(out)
    gaps.sort(key=lambda g: (g["level"], g["priority"], g["freq_rank"], g["sense_id"]))
    return merged, gaps


def make_batches(gaps: list[dict], batch_size: int) -> None:
    if batch_size <= 0:
        return
    BATCH_DIR.mkdir(parents=True, exist_ok=True)
    for old in BATCH_DIR.glob("batch_*.json"):
        old.unlink()
    for i in range(0, len(gaps), batch_size):
        batch_no = i // batch_size + 1
        items = [
            {
                "sense_id": g["sense_id"],
                "headword": g["headword"],
                "level": g["level"],
                "missing": g["missing"],
                "gloss_en": g["gloss_en"],
                "example_en": g["example_en"],
            }
            for g in gaps[i : i + batch_size]
        ]
        dump_json(
            BATCH_DIR / f"batch_{batch_no:04d}.json",
            {
                "_instruction": (
                    "Fill missing Chinese fields. gloss_cn should be concise learner Chinese; "
                    "example_cn should translate example_en naturally and keep the same meaning. "
                    "Return records keyed by sense_id for pipeline/_work/cn_translations.json."
                ),
                "items": items,
            },
        )


def build_payload(source: dict, senses: list[dict], gaps: list[dict]) -> dict:
    payload = deepcopy(source)
    payload["meta"]["stage"] = "3_translate_cn"
    payload["meta"]["cn_counts"] = {
        "senses": len(senses),
        "with_gloss_cn": sum(1 for s in senses if s["gloss_cn"]),
        "with_example_cn": sum(1 for s in senses if s["example_cn"]),
        "complete": len(senses) - len(gaps),
        "gaps": len(gaps),
    }
    payload["senses"] = senses
    return payload


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--allow-missing", action="store_true")
    parser.add_argument("--batch-size", type=int, default=100)
    args = parser.parse_args(argv)

    source = load_json(SRC, None)
    if not source:
        print(f"! missing input: {SRC}", file=sys.stderr)
        return 1
    seeds = load_json(SEED, {}).get("glosses", {})
    cache = normalize_cache(load_json(CACHE, {}))
    senses, gaps = apply_cn_sources(source["senses"], seeds, cache)
    payload = build_payload(source, senses, gaps)

    dump_json(PARTIAL, payload)
    dump_json(GAPS, {"count": len(gaps), "gaps": gaps})
    make_batches(gaps, args.batch_size)

    c = payload["meta"]["cn_counts"]
    print(
        f"中文释义 {c['with_gloss_cn']}/{c['senses']} | "
        f"例句翻译 {c['with_example_cn']}/{c['senses']} | 缺口 {c['gaps']}"
    )
    print(f"→ {PARTIAL}")
    print(f"→ {GAPS}")
    if gaps and args.batch_size > 0:
        print(f"→ {BATCH_DIR}")

    if gaps:
        print("! 中文未满覆盖，未写 data/senses.json。补齐 cn_translations.json 后重跑。", file=sys.stderr)
        return 0 if args.allow_missing else 2

    dump_json(FINAL, payload)
    print(f"→ {FINAL}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
