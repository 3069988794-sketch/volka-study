"""5_validate.py - schema and quality gates for data/senses.json."""
from __future__ import annotations

import json
import random
import re
import sys
from pathlib import Path
from typing import Iterable

ROOT = Path(__file__).resolve().parent.parent
FINAL = ROOT / "data" / "senses.json"
REGISTRY = ROOT / "data" / "id_registry.json"

REQUIRED_FIELDS = {
    "sense_id",
    "natural_key",
    "headword",
    "pos",
    "level",
    "gloss_en",
    "gloss_cn",
    "example_en",
    "example_cn",
    "lemma",
    "ipa",
    "syllables",
    "zipf",
    "freq_rank",
    "chunk",
    "priority",
}
CJK = re.compile(r"[一-鿿]")


def fail(messages: Iterable[str]) -> int:
    for message in messages:
        print(f"! {message}", file=sys.stderr)
    return 1


def main() -> int:
    errors: list[str] = []
    if not FINAL.exists():
        return fail([f"missing {FINAL}"])
    if not REGISTRY.exists():
        return fail([f"missing {REGISTRY}"])

    payload = json.loads(FINAL.read_text(encoding="utf-8"))
    registry = json.loads(REGISTRY.read_text(encoding="utf-8"))
    senses = payload.get("senses", [])
    words = payload.get("words", [])

    if len(senses) != 7223:
        errors.append(f"sense count expected 7223, got {len(senses)}")
    if len(words) != 2998:
        errors.append(f"word count expected 2998, got {len(words)}")

    ids = [s.get("sense_id") for s in senses]
    if len(ids) != len(set(ids)):
        errors.append("sense_id is not globally unique")
    active_ids = {rec["id"] for rec in registry.get("entries", {}).values()}
    missing_from_registry = sorted(set(ids) - active_ids)
    if missing_from_registry:
        errors.append(f"{len(missing_from_registry)} sense ids not present in registry")

    for idx, sense in enumerate(senses):
        missing = sorted(REQUIRED_FIELDS - set(sense))
        if missing:
            errors.append(f"sense[{idx}] missing fields: {missing}")
        if not sense.get("example_en"):
            errors.append(f"{sense.get('sense_id')} missing example_en")
        if not CJK.search(str(sense.get("gloss_cn", ""))):
            errors.append(f"{sense.get('sense_id')} missing Chinese gloss")
        if not CJK.search(str(sense.get("example_cn", ""))):
            errors.append(f"{sense.get('sense_id')} missing Chinese example")

    sample = random.Random(20260729).sample(senses, min(30, len(senses)))
    review = [
        {
            "sense_id": s["sense_id"],
            "headword": s["headword"],
            "gloss_en": s["gloss_en"],
            "gloss_cn": s["gloss_cn"],
            "example_en": s["example_en"],
            "example_cn": s["example_cn"],
        }
        for s in sample
    ]
    review_path = ROOT / "pipeline" / "_work" / "manual_review_sample.json"
    review_path.write_text(json.dumps(review, ensure_ascii=False, indent=1), encoding="utf-8")

    if errors:
        return fail(errors[:50] + ([f"... {len(errors) - 50} more errors"] if len(errors) > 50 else []))

    print("schema ok")
    print("sense count 7223 / examples 7223 / Chinese coverage 100%")
    print(f"manual review sample → {review_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
