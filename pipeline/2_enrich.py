"""2_enrich.py — 给义项补音标、屈折、词频、语块、学习优先级

输入：_work/senses_raw.json（1_extract.py 的产物，纯 PDF 结构）
输出：_work/senses_enriched.json

这一步只加「可以离线算出来的」字段，不碰中文、不碰 ID。中文在 3_translate_cn.py，
ID 由 1_extract.py 的注册表决定，这里原样带过。

priority 按 PLAN.md 2.5 的 T0–T4 分带：显式列出的子分类用它自己的带，没列的按义项
自身 CEFR 等级落到对应阶段。同一个子分类号会在四个阶段里各出现一次（66 个号 × 出现
228 次），所以最终取「显式带」和「等级默认带」里更靠后的那个——B2 的 1.1 人际关系
不该在头两周就冒出来。
"""
from __future__ import annotations

import json
import re
from pathlib import Path

import cmudict
import lemminflect
from wordfreq import zipf_frequency

ROOT = Path(__file__).resolve().parent.parent
WORK = ROOT / "pipeline" / "_work"
SRC = WORK / "senses_raw.json"
OUT = WORK / "senses_enriched.json"

# PLAN.md 2.5：生存优先的五个带，键是子分类号
PRIORITY_BANDS: dict[str, int] = {
    **{k: 0 for k in ("7.1", "2.1", "2.6", "2.7", "5.8", "5.6", "1.10", "1.8", "1.3")},
    **{k: 1 for k in ("1.4", "1.2", "3.2", "1.7", "1.11", "5.2", "5.3", "2.4", "2.5")},
    **{k: 2 for k in ("6.1", "3.3", "3.5", "1.17", "4.10", "1.1", "1.9")},
    **{k: 3 for k in ("1.5", "1.14", "1.6", "3.9", "4.21", "2.8")},
    **{k: 4 for k in ("1.18", "1.16", "1.15", "4.20", "4.12")},
}
LEVEL_BAND = {"A1": 1, "A2": 2, "B1": 3, "B2": 4, "C1": 4, "C2": 4}

# ARPAbet → IPA。cmudict 的音素带重音数字，先剥掉再查。
ARPA_IPA = {
    "AA": "ɑ", "AE": "æ", "AH": "ʌ", "AO": "ɔ", "AW": "aʊ", "AY": "aɪ",
    "B": "b", "CH": "tʃ", "D": "d", "DH": "ð", "EH": "ɛ", "ER": "ɝ",
    "EY": "eɪ", "F": "f", "G": "ɡ", "HH": "h", "IH": "ɪ", "IY": "i",
    "JH": "dʒ", "K": "k", "L": "l", "M": "m", "N": "n", "NG": "ŋ",
    "OW": "oʊ", "OY": "ɔɪ", "P": "p", "R": "ɹ", "S": "s", "SH": "ʃ",
    "T": "t", "TH": "θ", "UH": "ʊ", "UW": "u", "V": "v", "W": "w",
    "Y": "j", "Z": "z", "ZH": "ʒ",
}
VOWELS = {k for k in ARPA_IPA if k[0] in "AEIOU"}
UPOS = {
    "n.": "NOUN",
    "v.": "VERB",
    "auxiliary v.": "VERB",
    "adj.": "ADJ",
    "adv.": "ADV",
}
# 情态动词不走屈折表（could 在词典里是独立词条），但切语块时要认得出来
MODAL_FORMS = {
    "can": ["could"],
    "will": ["would", "’ll", "'ll"],
    "shall": ["should"],
    "may": ["might"],
    "must": [],
    "be": ["am", "is", "are", "was", "were", "been", "being", "’s", "’re", "’m"],
    "have": ["has", "had", "having", "’ve", "’s"],
    "do": ["does", "did", "done", "doing"],
    "let": ["lets", "letting", "let’s", "let's"],
    "not": ["n’t", "n't"],
}

CMU = cmudict.dict()


def norm_apostrophe(s: str) -> str:
    return s.replace("’", "'").replace("‘", "'")


def lemma_of(headword: str) -> str:
    """词形 → 查词典用的基本形。

    原书为区分同形词加了后缀和括注：`ring1`、`last1 (final)`、`kind (caring)`、
    `light (from the sun/a lamp)`。查音标和词频要用括注前、数字后缀前的那部分。
    `a, an` 这类并列写法取第一个。
    """
    base = headword.split("(")[0].strip()
    base = base.split(",")[0].strip()
    return re.sub(r"\d+$", "", base).strip()


def ipa_of(lemma: str) -> tuple[str, int]:
    """(IPA, 音节数)。多词词条逐词查，任一词查不到就整体放弃，不猜。"""
    parts = [p for p in re.split(r"[\s\-]+", norm_apostrophe(lemma).lower()) if p]
    out: list[str] = []
    syllables = 0
    for part in parts:
        entry = CMU.get(part)
        if not entry:
            return "", 0
        phones = entry[0]
        syllables += sum(1 for p in phones if p.rstrip("012") in VOWELS)
        out.append("".join(ARPA_IPA.get(p.rstrip("012"), "") for p in phones))
    return " ".join(out), syllables


def inflections_of(lemma: str, pos: str) -> dict[str, str]:
    upos = UPOS.get(pos)
    if not upos or " " in lemma or not lemma.isalpha():
        return {}
    got = lemminflect.getAllInflections(lemma.lower(), upos=upos)
    return {tag: forms[0] for tag, forms in sorted(got.items()) if forms}


def chunk_of(example: str, lemma: str, inflections: dict[str, str]) -> str:
    """从例句里切出含该词的语块，跟读时按语块停顿，比按整句更接近口语节奏。

    先找词形出现的位置（含屈折形式、情态与助动词的变体、多词词条的整个短语），
    再向两边各取两个词，遇到标点就停。找不到就返回空，不硬凑——凑出来的语块会教错节奏。
    """
    if not example:
        return ""
    text = norm_apostrophe(example)
    lem = norm_apostrophe(lemma).lower()
    forms = {lem, *(norm_apostrophe(f).lower() for f in inflections.values())}
    forms.update(norm_apostrophe(f).lower() for f in MODAL_FORMS.get(lem, []))
    tokens = re.findall(r"[A-Za-z'\-]+|[,;:.!?—]", text)
    lower = [t.lower() for t in tokens]
    words = [i for i, t in enumerate(lower) if t in forms]
    if not words:
        # 多词词条按短语找：no one / have to / a lot of，首词允许换成它的变体（has to）
        phrase = lem.split()
        if len(phrase) > 1:
            heads = [phrase[0], *(f.lower() for f in MODAL_FORMS.get(phrase[0], []))]
            for i in range(len(lower) - len(phrase) + 1):
                if lower[i] in heads and lower[i + 1 : i + len(phrase)] == phrase[1:]:
                    words = [i]
                    break
        # 去掉空格再比一次：Any more ↔ anymore
        if not words and " " in lem:
            joined = lem.replace(" ", "")
            words = [i for i, t in enumerate(lower) if t == joined]
        # 词干前缀兜底：headword 是派生形式或缩写时（let’s、o'clock）
        if not words and len(lem) > 3:
            words = [i for i, t in enumerate(lower) if t.startswith(lem[: len(lem) - 1])]
        if not words:
            return ""
    hit = words[0]
    span = len(lem.split()) - 1
    lo, hi = hit, min(hit + span, len(tokens) - 1)
    steps = 0
    while lo > 0 and steps < 2 and re.match(r"[A-Za-z'-]+", tokens[lo - 1]):
        lo -= 1
        steps += 1
    steps = 0
    while hi + 1 < len(tokens) and steps < 2 and re.match(r"[A-Za-z'-]+", tokens[hi + 1]):
        hi += 1
        steps += 1
    return " ".join(tokens[lo : hi + 1])


def priority_of(sub_no: str | None, level: str) -> str:
    """子分类显式列在 2.5 里就用那一带，没列的按义项自身等级落到对应阶段。

    不用 max(显式带, 等级带) 去「压后」：规划器的排序键是 (阶段, priority, 词频)，
    阶段本来就由义项自己的 CEFR 等级决定，B2 的 1.1 人际关系不会因为 priority 是 T2
    就跑到前面来。priority 只表达「同一阶段内谁更急着用上」。
    """
    band = PRIORITY_BANDS.get(sub_no or "")
    if band is None:
        band = LEVEL_BAND.get(level, 4)
    return f"T{band}"


def main() -> int:
    payload = json.loads(SRC.read_text(encoding="utf-8"))
    senses = payload["senses"]

    zipf_cache: dict[str, float] = {}
    for s in senses:
        lemma = lemma_of(s["headword"])
        s["lemma"] = lemma
        ipa, syl = ipa_of(lemma)
        s["ipa"] = ipa
        s["syllables"] = syl
        s["inflections"] = inflections_of(lemma, s["pos"])
        if lemma.lower() not in zipf_cache:
            zipf_cache[lemma.lower()] = round(zipf_frequency(lemma.lower(), "en"), 2)
        s["zipf"] = zipf_cache[lemma.lower()]
        s["chunk"] = chunk_of(s["example_en"], lemma, s["inflections"])
        s["priority"] = priority_of(s["sub_no"], s["level"])

    # freq_rank：按 zipf 从高到低给「词形」排名（同 zipf 按字母序），义项共享词形的排名
    order = sorted(zipf_cache, key=lambda w: (-zipf_cache[w], w))
    rank = {w: i + 1 for i, w in enumerate(order)}
    for s in senses:
        s["freq_rank"] = rank[s["lemma"].lower()]

    no_ipa = sorted({s["headword"] for s in senses if not s["ipa"]})
    no_chunk = [s for s in senses if not s["chunk"]]
    zero_freq = sorted({s["lemma"] for s in senses if s["zipf"] == 0})
    counts = {
        "senses": len(senses),
        "with_ipa": sum(1 for s in senses if s["ipa"]),
        "with_inflections": sum(1 for s in senses if s["inflections"]),
        "with_chunk": sum(1 for s in senses if s["chunk"]),
        "missing_ipa_headwords": len(no_ipa),
        "missing_chunk": len(no_chunk),
        "zero_frequency_lemmas": len(zero_freq),
    }
    by_priority = {
        t: sum(1 for s in senses if s["priority"] == t)
        for t in ("T0", "T1", "T2", "T3", "T4")
    }

    payload["meta"]["stage"] = "2_enrich"
    payload["meta"]["enrich_counts"] = counts
    payload["meta"]["by_priority"] = by_priority
    payload["enrich_review"] = {
        "headwords_without_ipa": no_ipa,
        "lemmas_without_frequency": zero_freq,
        "senses_without_chunk": [
            {"sense_id": s["sense_id"], "headword": s["headword"], "example_en": s["example_en"]}
            for s in no_chunk[:200]
        ],
    }
    OUT.write_text(json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8")

    print(f"音标 {counts['with_ipa']}/{counts['senses']} | 屈折 {counts['with_inflections']}"
          f" | 语块 {counts['with_chunk']}")
    print(f"无音标词形 {counts['missing_ipa_headwords']} | 无语块 {counts['missing_chunk']}"
          f" | 零词频 {counts['zero_frequency_lemmas']}")
    print(f"优先级 {by_priority}")
    print(f"→ {OUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
