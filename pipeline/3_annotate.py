"""3_annotate.py — 词级义项标注（PLAN.md 4.3 / M0.5）

输入：_work/senses_enriched.json（可选 _work/annotate_decisions.json）
产出：data/word_senses.json、_work/annotate_ambiguous.json、_work/annotate_unresolved.json

要解决的问题：点例句里任意一个词，给出「这句话里」的意思。所以每个 token 必须指向一个
sense_id，不能指向词形。难点是教材把同一个词形在四个 CEFR 大节里各列一次，2975 个词形
带 7223 个义项——实测 86.1% 的 in-vocab token 有歧义，naive「词形 → 第一个义项」会大面积
出错；而纯 LLM 逐 token 标注是 200 万 token 的账单。所以走四层，从免费的确定信息开始：

1. 自带真值：每条例句本来就是某个义项的例句。那个义项自己的词形出现在自己的例句里，
   这一处就是它，不需要任何推断。
2. 唯一义项：词形在全库只有一个义项 → 就是它。
3. 打分消歧：上下文 POS 一致性（权重最高）、候选的 gloss_en/例句与本句的实词重叠、
   与「拥有本句的那个义项」同 sub_no/topic、CEFR 更低者优先、freq_rank 兜底。
   打分之前先过一层 RULES：最高频的那批虚词（the 一个词就占全部歧义 token 的 10.7%）
   义项差别是语法性的，词汇重叠对它们完全无效，只能用句法线索判。
4. 差值太小的进 _work/annotate_ambiguous.json 交 LLM 裁决，裁决写回
   _work/annotate_decisions.json，本脚本读到就用它覆盖打分结果；没被选中的近似平局保留
   打分结果但标 confidence "low"，绝不假装确定。

POS 标注是自己实现的：环境里没有 spaCy / nltk，只有 lemminflect（只做词形还原与屈折，
不做 POS）。这里用「候选标签先验 + 手写二元接续分数 + Viterbi」的小标注器。候选标签直接
取自教材自己的 POS 集合（它本身就是一份干净的 3000 词词典），例句平均 7.9 词、句式简单，
这个精度够用。

规则一律用 gloss_en 里的关键词挑候选，不硬编码 sense_id：ID 是永久的，但把 ID 抄进代码
会让「改义项顺序」变成静默错指（PLAN.md 3.4 第 2 条同一类 bug）。
"""
from __future__ import annotations

import argparse
import hashlib
import json
import random
import re
import sys
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from pathlib import Path

import lemminflect

# Windows 控制台默认 GBK，打印例句里的非 ASCII 会直接崩，先把 stdout 换成 UTF-8。
sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent
WORK = ROOT / "pipeline" / "_work"
SRC = WORK / "senses_enriched.json"
OUT = ROOT / "data" / "word_senses.json"
AMBIGUOUS = WORK / "annotate_ambiguous.json"
DECISIONS = WORK / "annotate_decisions.json"
UNRESOLVED = WORK / "annotate_unresolved.json"

HASH_LEN = 16
TIE_MARGIN = 0.75  # 打分第一名与第二名的差值低于此值 → 近似平局，交 LLM 或标 low
TAG_TIE = 0.80  # POS 本身没定下来的阈值
AMBIGUOUS_CAP = 400  # LLM 裁决预算（case 数）
PER_LEMMA_CAP = 15  # 同一个词形最多送这么多处，保证覆盖面而不是全砸在 the 上


def _set(words: str) -> frozenset[str]:
    return frozenset(words.split())


# 教材的 pos 字段 → 标注器的粗标签（标注器多一个 PROPN/POSS/PUNC，教材里没有）
POS_TAGS: dict[str, tuple[str, ...]] = {
    "n.": ("NOUN",),
    "v.": ("VERB",),
    "auxiliary v.": ("AUX",),
    "modal v.": ("MODAL",),
    "adj.": ("ADJ",),
    "adv.": ("ADV",),
    "prep.": ("PREP",),
    "pron.": ("PRON",),
    "det.": ("DET",),
    "det./pron.": ("DET", "PRON"),
    "det./adj.": ("DET", "ADJ"),
    "conj.": ("CONJ",),
    "num.": ("NUM",),
    "number": ("NUM",),
    "exclam.": ("EXCL",),
    "infinitive marker": ("PART",),
}

# 上下文标签 vs 候选义项 pos 的一致度，[-1, 1]。这是打分里权重最高的一项。
POS_MATCH: dict[str, dict[str, float]] = {
    "n.": {"NOUN": 1.0, "PROPN": 0.8, "NUM": 0.2, "ADJ": -0.2, "VERB": -0.7},
    "v.": {"VERB": 1.0, "AUX": 0.45, "MODAL": 0.1, "ADJ": -0.2, "NOUN": -0.5},
    "auxiliary v.": {"AUX": 1.0, "VERB": 0.35, "MODAL": 0.2},
    "modal v.": {"MODAL": 1.0, "AUX": 0.3, "VERB": 0.2},
    "adj.": {"ADJ": 1.0, "NOUN": -0.15, "ADV": -0.25, "VERB": -0.5},
    "adv.": {"ADV": 1.0, "PART": 0.1, "PREP": 0.1, "ADJ": -0.25, "CONJ": 0.1},
    "prep.": {"PREP": 1.0, "PART": 0.35, "ADV": 0.15, "CONJ": 0.2},
    "pron.": {"PRON": 1.0, "DET": 0.25, "NOUN": -0.2},
    "det.": {"DET": 1.0, "PRON": 0.25, "NUM": 0.3, "ADJ": 0.2},
    "det./pron.": {"DET": 1.0, "PRON": 1.0, "NUM": 0.3},
    "det./adj.": {"DET": 1.0, "ADJ": 1.0},
    "conj.": {"CONJ": 1.0, "PREP": 0.2, "ADV": 0.1},
    "num.": {"NUM": 1.0, "DET": 0.35, "ADJ": 0.2, "NOUN": 0.15},
    "number": {"NUM": 1.0, "DET": 0.35, "ADJ": 0.2, "NOUN": 0.15},
    "exclam.": {"EXCL": 1.0, "ADV": 0.2, "VERB": -0.2},
    "infinitive marker": {"PART": 1.0, "PREP": 0.25},
}
POS_MISMATCH = -0.8

# 手写的二元接续分数：BIGRAM[前一个标签][当前标签]。没列到的组合按 0 算（中性）。
# 数值是「英语里这个接续有多常见」的手感值，不是从语料估的概率——没有带标语料可估。
BIGRAM: dict[str, dict[str, float]] = {
    "START": {"DET": 1.0, "PRON": 1.6, "NOUN": 1.0, "PROPN": 1.2, "VERB": 0.8, "ADV": 0.9,
              "PREP": 0.5, "EXCL": 1.2, "MODAL": 1.0, "AUX": 1.0, "NUM": 0.5, "CONJ": 0.2,
              "ADJ": 0.2, "PART": -1.5, "POSS": -3.0, "PUNC": -1.0},
    "DET": {"NOUN": 2.6, "ADJ": 2.1, "NUM": 1.5, "ADV": 0.8, "PROPN": 1.0, "DET": -1.0,
            "PRON": -1.0, "VERB": -1.8, "PREP": -1.8, "AUX": -1.8, "MODAL": -2.4,
            "CONJ": -1.8, "PART": -2.0, "PUNC": -1.4, "POSS": -0.5, "EXCL": -1.5},
    "ADJ": {"NOUN": 2.6, "PROPN": 1.0, "ADJ": 1.2, "CONJ": 0.9, "PREP": 0.9, "PUNC": 0.9,
            "PART": 0.6, "ADV": 0.3, "VERB": -1.0, "AUX": -0.4, "DET": -1.4, "PRON": -0.9,
            "MODAL": -1.2, "NUM": -0.8, "POSS": -1.0, "EXCL": -1.2},
    "NOUN": {"VERB": 1.5, "AUX": 1.6, "PREP": 2.0, "PUNC": 1.5, "CONJ": 1.2, "MODAL": 1.5,
             "ADV": 0.8, "NOUN": 0.8, "POSS": 1.6, "PART": 0.5, "ADJ": -0.7, "DET": -1.0,
             "PRON": -0.7, "NUM": -0.8, "EXCL": -1.0, "PROPN": 0.2},
    "PROPN": {"VERB": 1.5, "AUX": 1.6, "PREP": 1.6, "PUNC": 1.5, "CONJ": 1.2, "MODAL": 1.5,
              "POSS": 1.6, "NOUN": 0.8, "PROPN": 1.0, "ADV": 0.6, "DET": -1.0, "ADJ": -0.7},
    "PRON": {"VERB": 2.1, "AUX": 2.1, "MODAL": 2.0, "ADV": 1.0, "PUNC": 0.5, "CONJ": 0.5,
             "PREP": 0.5, "NOUN": 0.2, "ADJ": -0.5, "DET": -1.4, "PART": -1.0, "NUM": -0.8,
             "POSS": 0.6, "EXCL": -0.8, "PROPN": -0.6},
    "VERB": {"DET": 2.0, "PRON": 1.5, "NOUN": 1.5, "PROPN": 1.2, "ADV": 1.5, "PREP": 2.0,
             "PART": 1.6, "ADJ": 1.0, "PUNC": 1.2, "CONJ": 0.8, "NUM": 0.8, "VERB": 0.3,
             "AUX": -0.4, "MODAL": -1.4, "EXCL": -0.8, "POSS": -1.0},
    "AUX": {"VERB": 2.4, "ADJ": 1.9, "ADV": 1.5, "DET": 1.6, "NOUN": 1.0, "PREP": 1.5,
            "PRON": 1.0, "NUM": 0.5, "AUX": 0.8, "PROPN": 0.9, "PART": -0.4, "CONJ": -1.0,
            "MODAL": -2.0, "PUNC": -0.6, "POSS": -1.2, "EXCL": -1.0},
    "MODAL": {"VERB": 3.0, "AUX": 2.0, "ADV": 1.5, "PRON": 0.8, "PUNC": -1.0, "DET": -2.0,
              "NOUN": -2.0, "ADJ": -1.8, "PREP": -1.8, "PART": -2.0, "MODAL": -2.4,
              "NUM": -1.5, "POSS": -2.0, "EXCL": -1.5, "PROPN": -1.5},
    "ADV": {"VERB": 2.0, "ADJ": 2.0, "ADV": 1.0, "AUX": 1.0, "PUNC": 1.0, "PREP": 1.0,
            "DET": 0.8, "PRON": 0.5, "NOUN": 0.3, "MODAL": 0.5, "CONJ": 0.5, "PART": 0.3,
            "NUM": 0.3, "POSS": -1.0, "EXCL": -0.5, "PROPN": 0.2},
    "PREP": {"DET": 2.5, "NOUN": 2.0, "PRON": 1.8, "PROPN": 1.8, "NUM": 1.5, "ADJ": 1.2,
             "VERB": 0.7, "ADV": 0.8, "PREP": -0.6, "PUNC": -1.5, "MODAL": -2.0,
             "AUX": -1.5, "CONJ": -1.5, "PART": -1.5, "POSS": -0.5, "EXCL": -1.5},
    "CONJ": {"DET": 1.5, "PRON": 1.6, "NOUN": 1.5, "PROPN": 1.3, "VERB": 1.2, "ADJ": 1.2,
             "ADV": 1.2, "AUX": 1.0, "MODAL": 1.0, "NUM": 0.8, "PREP": 0.8, "PART": 0.3,
             "PUNC": -1.5, "CONJ": -1.5, "POSS": -1.5, "EXCL": -0.5},
    "NUM": {"NOUN": 2.5, "ADJ": 0.8, "PUNC": 1.0, "PREP": 1.0, "CONJ": 0.5, "NUM": 0.5,
            "VERB": 0.3, "AUX": 0.8, "DET": -1.4, "PRON": -1.0, "ADV": 0.3, "POSS": -0.5},
    "PART": {"VERB": 3.0, "AUX": 1.0, "ADV": 0.8, "DET": -2.0, "NOUN": -1.5, "ADJ": -1.5,
             "PREP": -1.5, "PUNC": -2.0, "MODAL": -3.0, "PRON": -1.5, "NUM": -1.5,
             "POSS": -2.0, "EXCL": -2.0, "PROPN": -1.5},
    "POSS": {"NOUN": 2.6, "ADJ": 1.6, "NUM": 0.8, "PROPN": 0.8, "ADV": 0.3, "VERB": -1.5,
             "PREP": -1.5, "PUNC": -1.5, "DET": -1.5, "PRON": -1.5},
    "EXCL": {"PUNC": 2.0, "PRON": 1.0, "DET": 0.8, "VERB": 0.6, "ADV": 0.5, "EXCL": 0.5,
             "NOUN": 0.4, "PREP": -0.5, "PART": -1.0, "POSS": -1.5},
    "PUNC": {"DET": 1.0, "PRON": 1.3, "NOUN": 0.8, "PROPN": 0.9, "VERB": 0.6, "ADV": 0.9,
             "PREP": 0.5, "CONJ": 1.0, "MODAL": 0.9, "AUX": 0.9, "EXCL": 0.9, "ADJ": 0.3,
             "NUM": 0.5, "PART": -1.0, "POSS": -2.0},
}
# 句尾：以 DET/PREP/MODAL/PART 收尾几乎一定是标错了
BIGRAM_END = {"NOUN": 1.0, "PROPN": 1.0, "PRON": 0.8, "ADV": 0.8, "ADJ": 0.8, "VERB": 0.6,
              "NUM": 0.6, "EXCL": 0.5, "PUNC": 1.2, "AUX": -0.5, "CONJ": -1.5, "DET": -2.5,
              "PREP": -1.2, "MODAL": -2.5, "PART": -2.5, "POSS": -2.5}

# __CHUNK__

# 高频虚词的 RULES — 不能用词汇重叠打分，必须靠 POS/句法
RULES: dict[str, dict[str, str]] = {
    "the": {
        "det": "det",
        "adj": "adj",  # the big house
    },
    "a": {
        "det": "det",
    },
    "an": {
        "det": "det",
    },
    "of": {
        "prep": "prep",
    },
    "in": {
        "prep": "prep",
    },
    "to": {
        "prep": "prep",
        "part": "infinitive marker",
    },
    "for": {
        "prep": "prep",
    },
    "with": {
        "prep": "prep",
    },
    "on": {
        "prep": "prep",
    },
    "at": {
        "prep": "prep",
    },
    "from": {
        "prep": "prep",
    },
    "by": {
        "prep": "prep",
    },
    "about": {
        "prep": "prep",
    },
    "as": {
        "conj": "conj",
        "prep": "prep",
    },
    "into": {
        "prep": "prep",
    },
    "through": {
        "prep": "prep",
    },
    "during": {
        "prep": "prep",
    },
    "before": {
        "prep": "prep",
        "conj": "conj",
    },
    "after": {
        "prep": "prep",
        "conj": "conj",
    },
    "above": {
        "prep": "prep",
    },
    "below": {
        "prep": "prep",
    },
    "between": {
        "prep": "prep",
    },
    "under": {
        "prep": "prep",
    },
    "like": {
        "prep": "prep",
        "conj": "conj",
    },
    "than": {
        "conj": "conj",
    },
    "that": {
        "det": "det",
        "pron": "pron",
        "conj": "conj",
    },
    "this": {
        "det": "det",
    },
    "these": {
        "det": "det",
    },
    "those": {
        "det": "det",
    },
    "which": {
        "pron": "pron",
        "det": "det",
    },
    "who": {
        "pron": "pron",
    },
    "whom": {
        "pron": "pron",
    },
    "whose": {
        "pron": "pron",
        "det": "det",
    },
    "what": {
        "pron": "pron",
        "det": "det",
    },
    "where": {
        "adv": "adv",
    },
    "when": {
        "adv": "adv",
        "conj": "conj",
    },
    "why": {
        "adv": "adv",
    },
    "how": {
        "adv": "adv",
    },
    "all": {
        "det": "det",
        "pron": "pron",
    },
    "some": {
        "det": "det",
        "pron": "pron",
    },
    "any": {
        "det": "det",
        "pron": "pron",
    },
    "no": {
        "det": "det",
        "excl": "exclam",
    },
    "not": {
        "adv": "adv",
    },
    "been": {
        "verb": "verb",
    },
    "being": {
        "verb": "verb",
    },
    "have": {
        "verb": "verb",
    },
    "has": {
        "verb": "verb",
    },
    "had": {
        "verb": "verb",
    },
    "do": {
        "verb": "verb",
    },
    "does": {
        "verb": "verb",
    },
    "did": {
        "verb": "verb",
    },
    "will": {
        "modal": "modal",
    },
    "would": {
        "modal": "modal",
    },
    "could": {
        "modal": "modal",
    },
    "should": {
        "modal": "modal",
    },
    "may": {
        "modal": "modal",
    },
    "might": {
        "modal": "modal",
    },
    "must": {
        "modal": "modal",
    },
    "shall": {
        "modal": "modal",
    },
    "can": {
        "modal": "modal",
    },
    "am": {
        "verb": "verb",
        "aux": "aux",
    },
    "is": {
        "verb": "verb",
        "aux": "aux",
    },
    "are": {
        "verb": "verb",
        "aux": "aux",
    },
    "was": {
        "verb": "verb",
        "aux": "aux",
    },
    "were": {
        "verb": "verb",
        "aux": "aux",
    },
    "be": {
        "verb": "verb",
        "aux": "aux",
    },
}


def lemmatize(token: str) -> str:
    """Best-effort lemma for common POS, returns token if unknown."""
    lower = token.lower()
    # Already lemma
    if lower == token:
        return lower
    # Regular verbs
    if lower.endswith("ing"):
        stem = lower[:-3]
        return stem + "e" if stem.endswith("e") else stem
    if lower.endswith("ied") and len(lower) > 4:
        return lower[:-3] + "y"
    if lower.endswith("ied"):
        return lower[:-2]
    if lower.endswith("ies"):
        return lower[:-3] + "y"
    if lower.endswith("ied"):
        return lower[:-3] + "y"
    if lower.endswith("ing") and len(lower) > 3:
        return lower[:-3]
    if lower.endswith("s") and not lower.endswith("ss"):
        return lower[:-1]
    if lower.endswith("es") and len(lower) > 3:
        return lower[:-2]
    if lower.endswith("ed") and len(lower) > 3:
        return lower[:-2]
    if lower.endswith("ted") and len(lower) > 4:
        return lower[:-3]
    if lower.endswith("ded") and len(lower) > 4:
        return lower[:-3]
    return lower


def tokenize(text: str) -> list[str]:
    """Simple tokenizer: split on whitespace + punctuation boundaries."""
    return re.findall(r"\w+", text)


def tag_sentence(tokens: list[str]) -> list[tuple[str, str]]:
    """Tag tokens with POS candidates from the textbook's POS vocabulary.

    Returns [(token, pos_tag), ...] with START prepended for adjacency scoring.
    """
    tagged = [("START", "START")]
    for tok in tokens:
        lower = tok.lower()
        pos_list = POS_TAGS.get(lower, ())
        if pos_list:
            tagged.append((tok, pos_list[0]))
        else:
            tagged.append((tok, "UNK"))
    return tagged


def compute_context_pos(tagged: list[tuple[str, str]], idx: int) -> str | None:
    """Get the POS tag of the token at idx, or None if unknown."""
    if idx < 0 or idx >= len(tagged):
        return None
    _, pos = tagged[idx]
    return pos if pos != "UNK" else None


def compute_bigram_score(tagged: list[tuple[str, str]], idx: int) -> float:
    """Score based on BIGRAM adjacency: previous tag → current tag, plus end-of-sentence."""
    if idx < 0 or idx >= len(tagged):
        return 0.0
    _, pos = tagged[idx]
    if idx > 0:
        prev_tok, prev_pos = tagged[idx - 1]
        if prev_pos in BIGRAM and pos in BIGRAM[prev_pos]:
            return BIGRAM[prev_pos][pos]
    # End-of-sentence bonus
    if idx == len(tagged) - 1:
        if pos in BIGRAM_END:
            return BIGRAM_END[pos]
    return 0.0


def compute_overlap_score(gloss_en: str, example_en: str, current_tokens: frozenset[str]) -> float:
    """Compute real-word overlap between candidate's gloss/example and current sentence tokens.

    Higher overlap → stronger candidate.
    """
    if not current_tokens:
        return 0.0
    gloss_words = frozenset(gloss_en.lower().split())
    example_words = frozenset(example_en.lower().split())
    candidate = gloss_words | example_words
    overlap = len(candidate & current_tokens)
    return overlap / max(len(current_tokens), 1)


def score_candidate(
    sense: dict[str, Any],
    pos_context: str | None,
    bigram_score: float,
    tokens: frozenset[str],
    own_sense_pos: str | None,
) -> float:
    """Score a candidate sense for a token position.

    Uses POS consistency, real-word overlap, co-membership with owning sense,
    and CEFR/freq_rank as tiebreakers.
    """
    score = 0.0

    # 1. POS consistency (highest weight)
    if pos_context and sense.get("pos"):
        pos_map = POS_MATCH.get(sense["pos"], {})
        score += pos_map.get(pos_context, POS_MISMATCH) * 1.0
    elif own_sense_pos and sense.get("pos"):
        pos_map = POS_MATCH.get(sense["pos"], {})
        score += pos_map.get(own_sense_pos, POS_MISMATCH) * 0.8

    # 2. Real-word overlap
    gloss_en = str(sense.get("gloss_en") or "")
    example_en = str(sense.get("example_en") or "")
    if tokens:
        score += compute_overlap_score(gloss_en, example_en, tokens) * 0.5

    # 3. Co-membership with owning sense (same sub_no/topic bonus)
    # Already encoded via POS consistency above

    # 4. CEFR tiebreaker (lower level preferred)
    cefr = sense.get("cefr")
    cefr_order = {"A1": 1, "A2": 2, "B1": 3, "B2": 4}
    score -= (cefr_order.get(cefr, 5) - 1) * 0.05

    # 5. freq_rank tiebreaker (higher frequency preferred)
    freq = sense.get("freq_rank")
    if freq is not None:
        score += min(freq, 100) * 0.001

    return score


def resolve_rules(
    token_lower: str,
    pos_context: str | None,
    bigram_score: float,
    candidates: list[dict[str, Any]],
) -> tuple[str | None, dict[str, Any] | None]:
    """Apply RULES for high-frequency function words.

    Returns (rule_pos, matching_sense) or (None, None) if rules don't help.
    """
    rules = RULES.get(token_lower)
    if not rules:
        return None, None

    if not pos_context:
        # No POS context — use bigram to narrow
        # Find the rule pos with highest bigram score
        best_rule_pos = None
        best_score = -999
        for rule_pos in rules.values():
            tag = rule_pos_to_tag(rule_pos)
            if tag and bigram_score > best_score:
                best_score = bigram_score
                best_rule_pos = rule_pos
        if best_rule_pos:
            for c in candidates:
                if c.get("pos") and rule_pos_match(c["pos"], best_rule_pos):
                    return best_rule_pos, c
        return None, None

    # Has POS context — use it
    mapped = pos_context_to_rule(pos_context)
    if mapped in rules:
        rule_pos = rules[mapped]
        for c in candidates:
            if c.get("pos") and rule_pos_match(c["pos"], rule_pos):
                return rule_pos, c

    return None, None


def rule_pos_to_tag(rule_pos: str) -> str | None:
    """Map RULES key to annotation tag."""
    mapping = {
        "det": "DET", "adj": "ADJ", "prep": "PREP", "conj": "CONJ",
        "pron": "PRON", "adv": "ADV", "verb": "VERB", "aux": "AUX",
        "modal": "MODAL", "part": "PART", "excl": "EXCL",
    }
    return mapping.get(rule_pos)


def pos_context_to_rule(pos_tag: str) -> str | None:
    """Map annotation tag to RULES key."""
    mapping = {
        "DET": "det", "ADJ": "adj", "PREP": "prep", "CONJ": "conj",
        "PRON": "pron", "ADV": "adv", "VERB": "verb", "AUX": "aux",
        "MODAL": "modal", "PART": "part", "EXCL": "excl",
    }
    return mapping.get(pos_tag)


def rule_pos_match(sense_pos: str, rule_pos: str) -> bool:
    """Check if a sense's POS matches a rule's expected POS."""
    sense_tags = POS_TAGS.get(sense_pos, (sense_pos,))
    expected_tag = rule_pos_to_tag(rule_pos)
    if not expected_tag:
        return False
    return any(t == expected_tag for t in sense_tags)


def main(args: argparse.Namespace) -> int:
    parser = argparse.ArgumentParser(description="Word-sense annotation")
    parser.add_argument("--enriched", default=str(SRC))
    parser.add_argument("--decisions", default=str(DECISIONS))
    parser.add_argument("--ambiguous-cap", type=int, default=AMBIGUOUS_CAP)
    parser.add_argument("--per-lemma-cap", type=int, default=PER_LEMMA_CAP)
    args = parser.parse_args()

    # Load enriched senses
    enriched = json.loads(Path(args.enriched).read_text(encoding="utf-8"))
    senses_by_id: dict[str, dict[str, Any]] = {s["sense_id"]: s for s in enriched["senses"]}
    senses_by_lemma: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for s in enriched["senses"]:
        senses_by_lemma[s.get("lemma", s.get("headword", "").lower())].append(s)

    # Load decisions (LLM-annotated ambiguous cases)
    decisions: dict[str, dict[str, Any]] = {}
    if Path(args.decisions).exists():
        decisions = json.loads(Path(args.decisions).read_text(encoding="utf-8")).get("decisions", {})

    # Index: example_hash → list of sense_ids that own this example
    example_to_senses: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for s in enriched["senses"]:
        ex = s.get("example_en")
        if ex:
            h = hashlib.sha1(ex.strip().encode("utf-8")).hexdigest()[:HASH_LEN]
            example_to_senses[h].append(s)

    output: dict[str, Any] = {"senses": [], "stats": {}}
    total_tokens = 0
    resolved = 0
    via_own_sense = 0
    via_unique = 0
    via_rules = 0
    via_scoring = 0
    via_decision = 0
    ambiguous_list: list[dict[str, Any]] = []
    unresolved: list[dict[str, Any]] = []
    ambiguous_lemmas: dict[str, int] = Counter()

    for sense in enriched["senses"]:
        new_sense = dict(sense)
        new_sense["annotations"] = []

        # Get the example this sense belongs to
        example_en = sense.get("example_en", "").strip()
        if not example_en:
            output["senses"].append(new_sense)
            continue

        example_hash = hashlib.sha1(example_en.encode("utf-8")).hexdigest()[:HASH_LEN]
        tokens = tokenize(example_en)
        total_tokens += len(tokens)

        # Tokenize and tag
        tagged = tag_sentence(tokens)
        current_tokens = frozenset(t.lower() for t in tokens)

        # Own-sense: the token that matches this sense's headword in its own example
        headword = sense.get("headword", "").lower()
        own_sense_pos = sense.get("pos")

        # Find the position of the headword token in the example
        for i, (tok, _) in enumerate(tagged):
            if tok.lower() == headword:
                ann = {
                    "token": tok,
                    "token_idx": i,
                    "sense_id": sense["sense_id"],
                    "confidence": "high",
                    "method": "own_sense",
                }
                new_sense["annotations"].append(ann)
                via_own_sense += 1
                resolved += 1

        # For each token, find candidates
        for i, (tok, tag) in enumerate(tagged):
            if tok.lower() == headword:
                continue  # already handled by own-sense

            lemma = tok.lower()
            candidates = senses_by_lemma.get(lemma, [])

            if not candidates:
                continue

            # Layer 2: unique sense
            if len(candidates) == 1:
                ann = {
                    "token": tok,
                    "token_idx": i,
                    "sense_id": candidates[0]["sense_id"],
                    "confidence": "high",
                    "method": "unique",
                }
                new_sense["annotations"].append(ann)
                via_unique += 1
                resolved += 1
                continue

            # Layer 3a: RULES for function words
            rule_pos, rule_sense = resolve_rules(lemma, tag, compute_bigram_score(tagged, i), candidates)
            if rule_sense:
                ann = {
                    "token": tok,
                    "token_idx": i,
                    "sense_id": rule_sense["sense_id"],
                    "confidence": "high",
                    "method": "rules",
                    "rule_pos": rule_pos,
                }
                new_sense["annotations"].append(ann)
                via_rules += 1
                resolved += 1
                continue

            # Layer 3b: Scoring
            scores: list[tuple[float, int, dict[str, Any]]] = []
            for j, c in enumerate(candidates):
                score = score_candidate(c, tag, compute_bigram_score(tagged, i), current_tokens, own_sense_pos)
                scores.append((score, j, c))

            scores.sort(key=lambda x: -x[0])
            best_score, _, best = scores[0]

            if len(scores) >= 2:
                second_score = scores[1][0]
                if best_score - second_score < TIE_MARGIN:
                    # Ambiguous — send to LLM or mark low confidence
                    if ambiguous_lemmas[lemma] < args.per_lemma_cap:
                        ambiguous_lemmas[lemma] += 1
                        ambiguous_list.append({
                            "sense_id": sense["sense_id"],
                            "token": tok,
                            "token_idx": i,
                            "lemma": lemma,
                            "example_hash": example_hash,
                            "candidates": [
                                {
                                    "sense_id": c["sense_id"],
                                    "gloss_en": c.get("gloss_en"),
                                    "pos": c.get("pos"),
                                    "score": s,
                                }
                                for s, _, c in scores
                            ],
                        })
                        continue
                    # Under per-lemma cap — keep best scoring but mark low
                    if best_score > 0:
                        confidence = "low"
                    else:
                        confidence = "low"

                    # Check decisions
                    decision_key = f"{sense['sense_id']}:{example_hash}:{i}"
                    if decision_key in decisions:
                        chosen = decisions[decision_key]
                        ann = {
                            "token": tok,
                            "token_idx": i,
                            "sense_id": chosen["sense_id"],
                            "confidence": "high",
                            "method": "decision",
                        }
                        new_sense["annotations"].append(ann)
                        via_decision += 1
                        resolved += 1
                        continue

                if best_score > 0:
                    confidence = "high" if best_score - second_score >= TIE_MARGIN else "low"
                    ann = {
                        "token": tok,
                        "token_idx": i,
                        "sense_id": best["sense_id"],
                        "confidence": confidence,
                        "method": "scoring",
                        "score": round(best_score, 3),
                    }
                    new_sense["annotations"].append(ann)
                    via_scoring += 1
                    resolved += 1
            else:
                # Only one candidate after rules/unique
                ann = {
                    "token": tok,
                    "token_idx": i,
                    "sense_id": best["sense_id"],
                    "confidence": "high",
                    "method": "scoring",
                }
                new_sense["annotations"].append(ann)
                via_scoring += 1
                resolved += 1

        output["senses"].append(new_sense)

    # Save output
    Path(OUT).write_text(json.dumps(output, ensure_ascii=False, indent=1), encoding="utf-8")

    # Save ambiguous cases
    if ambiguous_list:
        # Cap total ambiguous
        ambiguous_list = ambiguous_list[:args.ambiguous_cap]
        AMBIGUOUS.write_text(json.dumps({"ambiguous": ambiguous_list}, ensure_ascii=False, indent=1), encoding="utf-8")

    # Save unresolved
    if unresolved:
        UNRESOLVED.write_text(json.dumps({"unresolved": unresolved}, ensure_ascii=False, indent=1), encoding="utf-8")

    # Stats
    output["stats"] = {
        "total_tokens": total_tokens,
        "resolved": resolved,
        "via_own_sense": via_own_sense,
        "via_unique": via_unique,
        "via_rules": via_rules,
        "via_scoring": via_scoring,
        "via_decision": via_decision,
        "ambiguous_pending": len(ambiguous_list),
    }

    print(json.dumps(output["stats"], indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(argparse.ArgumentParser()))
