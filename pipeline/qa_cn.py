"""qa_cn.py - quality gate for the Chinese translation layer.

Structural checks that a human reviewer would otherwise have to do by hand across
7223 senses. Run after merge_cn_translations.py. Exit code is 0 only when every
BLOCKING check passes; WARN findings are printed but do not fail the run, because
some of them are legitimate (a gloss may need a Latin brand name, a sentence may
be quoting an English word on purpose).

    python pipeline/qa_cn.py                 # check the merged cache
    python pipeline/qa_cn.py --json out.json # also dump findings for triage
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from collections import defaultdict
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")

ROOT = Path(__file__).resolve().parent.parent
WORK = ROOT / "pipeline" / "_work"
CACHE = WORK / "cn_translations.json"
ENRICHED = WORK / "senses_enriched.json"
FIXES = ROOT / "pipeline" / "cn_fixes.json"

MAX_GLOSS_CHARS = 24
LATIN = re.compile(r"[A-Za-z]")
CJK = re.compile(r"[一-鿿]")
SENT_END = "。？！…"
TRAILING_PUNCT = "。，；、？！,.;:"

# Words that legitimately appear in a Chinese gloss because the item *is* an
# English grammar word and the gloss has to name it.
GRAMMAR_METALANGUAGE = re.compile(r"^[^A-Za-z]*(?:[A-Za-z]+[、，/\s]*)+[^A-Za-z]*$")


def load(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--json", dest="json_out")
    args = ap.parse_args(argv)

    cache = load(CACHE)["translations"]
    senses = {s["sense_id"]: s for s in load(ENRICHED)["senses"]}

    # Reviewed exceptions: a finding listed here is real output from a real rule,
    # but a curator has looked at the sense and decided the rule misfires on it
    # (usually a sentence that is deliberately *about* an English word). Downgrade
    # to WARN rather than dropping it, so the exception stays visible and auditable.
    accepted_raw = load(FIXES).get("accepted", {}) if FIXES.exists() else {}
    accepted: set[tuple[str, str]] = {
        (sid, code) for sid, rec in accepted_raw.items() for code in rec.get("codes", [])
    }
    used_accepted: set[tuple[str, str]] = set()

    blocking: list[tuple[str, str, str]] = []
    warn: list[tuple[str, str, str]] = []

    def block(sid: str, code: str, detail: str) -> None:
        if (sid, code) in accepted:
            used_accepted.add((sid, code))
            warn.append((sid, code, f"(accepted) {detail}"))
            return
        blocking.append((sid, code, detail))

    def soft(sid: str, code: str, detail: str) -> None:
        warn.append((sid, code, detail))

    by_headword: dict[str, list[tuple[str, str]]] = defaultdict(list)

    for sid, t in sorted(cache.items()):
        gloss = (t.get("gloss_cn") or "").strip()
        example = (t.get("example_cn") or "").strip()
        src = senses.get(sid)

        if src is None:
            block(sid, "unknown_sense", "sense_id not in senses_enriched.json")
            continue
        if not gloss:
            block(sid, "empty_gloss", "gloss_cn is blank")
        if not example:
            block(sid, "empty_example", "example_cn is blank")
        if not gloss or not example:
            continue

        # --- gloss_cn -------------------------------------------------------
        if not CJK.search(gloss):
            block(sid, "gloss_no_cjk", gloss)
        if len(gloss) > MAX_GLOSS_CHARS:
            block(sid, "gloss_too_long", f"{len(gloss)} chars: {gloss}")
        if gloss[-1] in TRAILING_PUNCT:
            block(sid, "gloss_trailing_punct", gloss)
        if LATIN.search(gloss) and not GRAMMAR_METALANGUAGE.search(gloss):
            soft(sid, "gloss_has_latin", gloss)
        if re.search(r"\b(n|v|adj|adv|prep|conj|pron)\.", gloss):
            block(sid, "gloss_has_pos_tag", gloss)
        if re.search(r"\b[ABC][12]\b", gloss):
            block(sid, "gloss_has_cefr_tag", gloss)
        # A gloss that is just the English definition translated word-for-word
        # tends to be long and start with 一种/用于形容.
        if gloss.startswith("一种") and len(gloss) > 12:
            soft(sid, "gloss_descriptive_style", gloss)

        by_headword[src["headword"]].append((sid, gloss))

        # --- example_cn -----------------------------------------------------
        if not CJK.search(example):
            block(sid, "example_no_cjk", example)
        if example[-1] not in SENT_END:
            block(sid, "example_bad_ending", example)
        # An untranslated run of three or more English words means the sentence
        # was copied rather than translated. One or two are usually a quoted
        # word the sentence is deliberately about.
        latin_runs = re.findall(r"[A-Za-z][A-Za-z'\- ]{2,}", example)
        long_run = next((r for r in latin_runs if len(r.split()) >= 3), None)
        if long_run:
            block(sid, "example_untranslated_run", long_run.strip())
        elif LATIN.search(example):
            soft(sid, "example_has_latin", example)
        if example == src["example_en"]:
            block(sid, "example_is_source", example)
        # A translation far shorter than the source has usually dropped content.
        en_words = len(src["example_en"].split())
        if en_words >= 8 and len(CJK.findall(example)) < en_words * 0.7:
            soft(sid, "example_maybe_truncated", f"{en_words}w -> {example}")

    # --- cross-sense checks -------------------------------------------------
    for headword, entries in sorted(by_headword.items()):
        if len(entries) < 2:
            continue
        seen: dict[str, str] = {}
        for sid, gloss in entries:
            if gloss in seen:
                block(
                    sid,
                    "gloss_collides_with_sibling",
                    f"{headword}: same as {seen[gloss]} -> {gloss}",
                )
            else:
                seen[gloss] = sid

    total = len(cache)
    # An accepted entry whose sense is in the cache but whose rule no longer fires
    # is dead weight — the translation changed and the exception outlived it.
    # Entries for senses not yet merged are skipped, since the cache fills in waves.
    stale = sorted(
        (sid, code)
        for sid, code in accepted - used_accepted
        if sid in cache
    )
    if stale:
        print("\nstale accepted entries in cn_fixes.json (rule no longer fires):")
        for sid, code in stale:
            print(f"  {sid}  {code}")

    print(f"checked {total} translations against {len(senses)} senses")
    print(f"  BLOCKING {len(blocking)}   WARN {len(warn)}")

    def summarize(rows: list[tuple[str, str, str]], label: str, limit: int) -> None:
        if not rows:
            return
        counts: dict[str, int] = defaultdict(int)
        for _, code, _ in rows:
            counts[code] += 1
        print(f"\n{label} by code:")
        for code, n in sorted(counts.items(), key=lambda kv: -kv[1]):
            print(f"  {n:>5}  {code}")
        print(f"\nfirst {limit} {label.lower()}:")
        for sid, code, detail in rows[:limit]:
            print(f"  {sid}  {code}  {detail}")

    summarize(blocking, "BLOCKING", 40)
    summarize(warn, "WARN", 25)

    if args.json_out:
        Path(args.json_out).write_text(
            json.dumps(
                {
                    "checked": total,
                    "blocking": [
                        {"sense_id": s, "code": c, "detail": d} for s, c, d in blocking
                    ],
                    "warn": [{"sense_id": s, "code": c, "detail": d} for s, c, d in warn],
                },
                ensure_ascii=False,
                indent=1,
            ),
            encoding="utf-8",
        )
        print(f"\n-> {args.json_out}")

    return 1 if blocking else 0


if __name__ == "__main__":
    raise SystemExit(main())
