"""2_seed_cn.py — 一次性打捞：从旧提取里抢出可用的中文释义

旧库 data/volka-raw.json 里的 gloss_cn 名不副实：6990 条里只有 433 条含中文，
其中 370 条是模板拼接（`……的人：writes or reports news stories`、`让……的东西：...`），
3788 条干脆是英文原文照抄。真正能用的只有 63 条，几乎全在代词那几页。

所以「继承旧中文」这条计划作废，改成：把这 63 条打捞成种子，其余靠 3_translate_cn.py
的批次逐步补齐。这个脚本只跑一次，产物是 data/cn_seed.json。

判据：含中日韩字符、不含连续英文字母、不含省略号占位符。
"""
from __future__ import annotations

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LEGACY = ROOT / "data" / "volka-raw.json"
OUT = ROOT / "data" / "cn_seed.json"

CJK = re.compile(r"[一-鿿]")
ASCII_WORD = re.compile(r"[A-Za-z]{2,}")


def main() -> int:
    entries = json.loads(LEGACY.read_text(encoding="utf-8"))["entries"]
    seed: dict[str, str] = {}
    total = 0
    for e in entries:
        for s in e["senses"]:
            total += 1
            cn = (s.get("gloss_cn") or "").strip()
            if not cn or not CJK.search(cn) or ASCII_WORD.search(cn) or "…" in cn:
                continue
            key = "|".join(
                [e["headword"], s["pos"], s["level"], s["gloss_en"].strip().lower()]
            )
            seed[key] = cn

    OUT.write_text(
        json.dumps(
            {
                "_readme": (
                    "键是 headword|pos|level|gloss_en(小写)。来源是旧提取里少数真人写过的"
                    "中文释义，3_translate_cn.py 用它当种子。"
                ),
                "source": LEGACY.name,
                "legacy_senses": total,
                "kept": len(seed),
                "glosses": seed,
            },
            ensure_ascii=False,
            indent=1,
            sort_keys=True,
        ),
        encoding="utf-8",
    )
    print(f"旧库义项 {total} → 可用中文 {len(seed)}")
    print(f"→ {OUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
