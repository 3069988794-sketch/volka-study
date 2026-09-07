"""make_cn_assignments.py - split the Chinese translation gap list into agent-sized files.

Reads pipeline/_work/translation_gaps.json (produced by 3_translate_cn.py) and writes
one JSON file per assignment into pipeline/_work/cn_assignments/. Each file is
self-contained: it carries the full instruction plus every field a translator needs, so
an agent can work from that one file without reading the rest of the repo.

Gaps arrive already sorted by (level, priority, freq_rank), so assignment a01 holds the
senses the learner meets first. Partial progress is safe: rerun 3_translate_cn.py and
this script, and only the still-missing senses are re-issued.
"""
from __future__ import annotations

import argparse
import json
import shutil
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
WORK = ROOT / "pipeline" / "_work"
GAPS = WORK / "translation_gaps.json"
OUT_DIR = WORK / "cn_assignments"

INSTRUCTION = (
    "为每个 sense_id 补 gloss_cn 与 example_cn。"
    "gloss_cn：面向中文母语初学者的简洁释义，8-18 字，不抄英文、不加词性标签、不加句末标点；"
    "必须与 gloss_en 同义，且与 example_en 中该词的实际用法一致。"
    "同一 headword 的多个义项，gloss_cn 必须互相区分得开。"
    "example_cn：example_en 的自然中文翻译，说人话，不逐词硬译，保留原句语气与信息；"
    "译文里要能看出目标词的意思。"
    "只输出 JSON，形如 {\"translations\": {\"s000123\": {\"gloss_cn\": \"...\", \"example_cn\": \"...\"}}}。"
)


def load_json(path: Path, default: Any) -> Any:
    if not path.exists():
        return default
    return json.loads(path.read_text(encoding="utf-8"))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--size", type=int, default=300)
    parser.add_argument("--prefix", default="a")
    args = parser.parse_args(argv)

    payload = load_json(GAPS, None)
    if not payload:
        print(f"! missing {GAPS}; run 3_translate_cn.py --allow-missing first")
        return 1

    gaps: list[dict] = payload["gaps"]
    if OUT_DIR.exists():
        shutil.rmtree(OUT_DIR)
    OUT_DIR.mkdir(parents=True)

    written = []
    for i in range(0, len(gaps), args.size):
        chunk = gaps[i : i + args.size]
        no = i // args.size + 1
        name = f"{args.prefix}{no:02d}.json"
        (OUT_DIR / name).write_text(
            json.dumps(
                {
                    "_instruction": INSTRUCTION,
                    "assignment": name,
                    "count": len(chunk),
                    "items": [
                        {
                            "sense_id": g["sense_id"],
                            "headword": g["headword"],
                            "level": g["level"],
                            "missing": g["missing"],
                            "gloss_en": g["gloss_en"],
                            "example_en": g["example_en"],
                        }
                        for g in chunk
                    ],
                },
                ensure_ascii=False,
                indent=1,
            ),
            encoding="utf-8",
        )
        written.append((name, len(chunk)))

    print(f"gaps {len(gaps)} -> {len(written)} assignments in {OUT_DIR}")
    for name, n in written:
        print(f"  {name}  {n}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
