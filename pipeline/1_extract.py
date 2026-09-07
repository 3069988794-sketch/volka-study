"""1_extract.py — PDF → 结构化义项列表 + 永久 ID 注册表

输入：3000 Textbook.pdf（经 pdftotext -raw 得到的 _work/raw_seq.txt）
输出：_work/senses_raw.json  纯 PDF 结构，无中文、无富化字段
      ../data/id_registry.json  永久不可变 ID 注册表（append-only）

为什么用 -raw 而不是 -layout：-layout 按版面坐标排序，水印文字把版面切碎后，
某条义项的续行会被排到它自己的义项行之前（page 88 的 `ice".` 出现在 tooth 之前，
page 174 的 `city".` 出现在那条 B2 义项之前），无法只凭位置判断归属。-raw 按 PDF
内容流顺序输出，续行永远紧跟自己的义项行，水印每页只剩一行 VolkaEnglish。

设计要点见 PLAN.md 3.4：sense_id 不是内容哈希。自然键用
(headword, pos, level, 组内序号)，这四项都不会因为修润英文释义而改变。
"""
from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WORK = ROOT / "pipeline" / "_work"
PDF = ROOT.parent / "3000 Textbook.pdf"
RAW_TXT = WORK / "raw_seq.txt"
REGISTRY = ROOT / "data" / "id_registry.json"
OVERRIDES = ROOT / "pipeline" / "overrides.json"
OUT = WORK / "senses_raw.json"

BODY_START_PAGE = 8
LVL = r"(?:A1|A2|B1|B2|C1|C2)"

# 词条行的词性标注写法很杂，实际出现过的形式：
#   I pron. A1                                   最常见
#   her pron., det. A1                           一组多词性
#   back n., adv. A1, adj. A2, v. B2             多组，各带自己的等级
#   fat adj. A1, n.A2                            等级前少一个空格
#   one number/det., pron. A1                    整词与缩写混用斜杠
#   second (next after the first) det./ number A1, adv. A2
#   best adj. A1, adv.                           行尾多挂一个没有等级的词性
#   the definite article A1  /  two number A1  /  to prep., infinitive marker A1
_POS_ONE = (
    r"(?:definite article|indefinite article|infinitive marker|number"
    r"|auxiliary v\.|auxiliary|modal v\.|modal|[a-z]+\.)"
)
_POS_TOKEN = rf"{_POS_ONE}(?:\s*/\s*{_POS_ONE})*"
_POS_GROUP = rf"{_POS_TOKEN}(?:,\s*{_POS_TOKEN})*"
_TAIL = (
    rf"{_POS_GROUP}\s*{LVL}(?:,\s*{_POS_GROUP}\s*{LVL})*(?:,\s*{_POS_GROUP})?"
)

RE_LEVEL = re.compile(r"^CEFR Level (\S+) Words$")
RE_TOPIC = re.compile(r"^(\d+)\. ([A-Z].+)$")
RE_SUB = re.compile(r"^(\d+\.\d+) ([A-Z].*?)[:\]]*$")
RE_SENSE = re.compile(rf"^({_POS_TOKEN})\s*({LVL})\s+(.+)$")
RE_HEADWORD = re.compile(rf"^(.+?) ({_TAIL})$")
RE_PAGE_NUMBER = re.compile(r"^\d{1,3}$")
# 少数义项正文前面挂了一个来自原书排版的序号：`n.A2 1 a liquid with ...`
RE_LEADING_ORDINAL = re.compile(r"^\d{1,2}\s+(?=[a-z])")

QUOTE_OPEN = '"“”’‘'


def clean(line: str) -> str:
    """去水印文字与零宽字符。

    零宽字符换成空格而不是删掉：page 219 有 `adj. B1​caring and helpful ...`，
    直接删掉会粘成 `B1caring`，义项行就认不出来了。
    """
    return line.replace("VolkaEnglish", "").replace("​", " ").strip()


def ensure_raw_text() -> str:
    if not RAW_TXT.exists():
        WORK.mkdir(parents=True, exist_ok=True)
        subprocess.run(
            ["pdftotext", "-raw", "-enc", "UTF-8", str(PDF), str(RAW_TXT)],
            check=True,
        )
    return RAW_TXT.read_text(encoding="utf-8")


def split_gloss_example(rest: str) -> tuple[str, str]:
    """义项正文 → (英文释义, 例句)。

    例句是引号包起来的那一段。取「第一个开引号」到「最后一个闭引号」之间的内容。
    """
    rest = RE_LEADING_ORDINAL.sub("", rest.strip())
    opens = [i for i, ch in enumerate(rest) if ch in '"“']
    if not opens:
        return normalize_space(rest).rstrip(" .,;:"), ""
    head = opens[0]
    gloss = normalize_space(rest[:head]).rstrip(" .,;:")
    tail = rest[head + 1 :]
    closes = [i for i, ch in enumerate(tail) if ch in '"”']
    example = normalize_space(tail[: closes[-1]] if closes else tail)
    # 少数义项给了两个例句，中间用 `” / “` 隔开（crowd）。只留第一句。
    example = re.split(r"[\"“”]\s*/\s*[\"“”]", example)[0]
    example = example.strip().strip("“”\"").strip()
    if example and example[-1] not in ".?!":
        example += "."
    return gloss, example


def normalize_space(s: str) -> str:
    return re.sub(r"\s+", " ", s).strip()


def parse(text: str) -> tuple[list[dict], dict]:
    pages = text.split("\f")
    senses: list[dict] = []
    stats = {
        "topics": set(),
        "subs": set(),
        "headwords": 0,
        "continuations": 0,
        "page_numbers": 0,
    }
    level_section = topic_no = topic = sub_no = sub_name = None
    headword = headword_tail = None
    started = False
    pending: list[str] = []
    strays: list[str] = []

    def flush() -> None:
        """把换行碎片拼回当前义项。

        -raw 保持 PDF 内容流顺序，续行永远紧跟自己的义项行，所以这里不需要判断归属：
        缓存的碎片一定属于最后一条义项。拼不上（还没有义项）的记进 strays 留待人工看。
        """
        if not pending:
            return
        if not senses:
            strays.extend(pending)
            pending.clear()
            return
        cur = senses[-1]
        cur["_rest"] = cur["_rest"].rstrip() + " " + " ".join(pending)
        stats["continuations"] += len(pending)
        pending.clear()
        cur["gloss_en"], cur["example_en"] = split_gloss_example(cur["_rest"])

    for page_no, page in enumerate(pages, 1):
        if page_no < BODY_START_PAGE:
            continue
        for line in page.split("\n"):
            s = clean(line)
            if not s:
                continue
            if RE_PAGE_NUMBER.match(s):
                stats["page_numbers"] += 1
                continue

            m_level = RE_LEVEL.match(s)
            m_sub = RE_SUB.match(s) if started else None
            m_top = RE_TOPIC.match(s) if started else None
            m_sn = RE_SENSE.match(s) if started else None
            m_hw = RE_HEADWORD.match(s) if started else None
            if m_level or m_sub or m_top or m_sn or m_hw:
                flush()

            if m_level:
                level_section, started = m_level.group(1), True
                continue
            if not started:
                continue

            if m_sub:
                sub_no, sub_name = m_sub.group(1), normalize_space(m_sub.group(2))
                stats["subs"].add((level_section, sub_no, sub_name))
                continue

            if m_top:
                topic_no, topic = m_top.group(1), normalize_space(m_top.group(2))
                stats["topics"].add(topic)
                continue

            if m_sn:
                gloss, example = split_gloss_example(m_sn.group(3))
                senses.append(
                    {
                        "headword": headword,
                        "headword_tail": headword_tail,
                        "pos": m_sn.group(1),
                        "level": m_sn.group(2),
                        "gloss_en": gloss,
                        "example_en": example,
                        "level_section": level_section,
                        "topic_no": topic_no,
                        "topic": topic,
                        "sub_no": sub_no,
                        "sub_name": sub_name,
                        "page": page_no,
                        "_rest": m_sn.group(3),
                    }
                )
                continue

            if m_hw:
                headword = normalize_space(m_hw.group(1))
                headword_tail = m_hw.group(2)
                stats["headwords"] += 1
                continue

            # 其余都是换行碎片，先缓存，等下一个结构行到来时再结算
            pending.append(s)

    flush()
    stats["strays"] = strays
    return senses, stats


def drop_ghost_lines(senses: list[dict]) -> tuple[list[dict], list[dict]]:
    """删掉原书串进别的词条里的孤立重复行。

    page 126 的 `century` 义项整行又出现在 page 127 的 `immediately` 中间，
    `earn` 的 B1 义项整行又出现在 `save` 中间。判据是「释义和例句都与前面某条一字不差」——
    例句是跟着词写的，两个不同的词不会碰巧配同一个例句。同释义但例句不同的（garbage /
    billion / primary / colored）是原书真给了两个例句，不动。
    """
    seen: set[tuple[str, str]] = set()
    kept: list[dict] = []
    ghosts: list[dict] = []
    for s in senses:
        key = (s["gloss_en"].strip().lower(), s["example_en"].strip().lower())
        if key in seen and s["example_en"]:
            ghosts.append(s)
            continue
        seen.add(key)
        kept.append(s)
    return kept, ghosts


def dedupe_repeated_runs(
    senses: list[dict], min_run: int = 3, max_run: int = 60, page_window: int = 3
) -> tuple[list[dict], list[dict]]:
    """删掉原书自己重复排版的整段义项。

    page 42 底部到 page 43 中部的 report/result/practice/homework/study/reading
    共 16 条，在 page 43 中部到 page 44 又原样重排了一遍（PDF 文本层里两份都在）。
    判据是「紧接着重复的一整段」：keys[i-r:i] == keys[i:i+r] 且页码相邻。单条重复
    不动——garbage / billion / primary / colored 是原书给同一释义配了两个例句，
    那是真内容。
    """
    key = lambda s: (s["headword"], s["pos"], s["gloss_en"].lower())  # noqa: E731
    keys = [key(s) for s in senses]
    dropped: list[dict] = []
    kept: list[dict] = []
    i = 0
    while i < len(senses):
        run = 0
        upper = min(max_run, i, len(senses) - i)
        for r in range(upper, min_run - 1, -1):
            if keys[i - r : i] == keys[i : i + r] and abs(
                senses[i]["page"] - senses[i - r]["page"]
            ) <= page_window:
                run = r
                break
        if run:
            dropped.extend(senses[i : i + run])
            i += run
            continue
        kept.append(senses[i])
        i += 1
    return kept, dropped


def assign_natural_keys(senses: list[dict]) -> None:
    """自然键 = headword|pos|level|组内序号。四项都与英文释义文本无关。"""
    counter: dict[tuple, int] = {}
    for s in senses:
        group = (s["headword"], s["pos"], s["level"])
        counter[group] = counter.get(group, 0) + 1
        s["natural_key"] = "|".join(
            [str(s["headword"]), s["pos"], s["level"], str(counter[group])]
        )


def apply_overrides(senses: list[dict]) -> tuple[int, list[str]]:
    """按自然键手工修原书的错处。改这里不影响 sense_id。"""
    if not OVERRIDES.exists():
        return 0, []
    spec = json.loads(OVERRIDES.read_text(encoding="utf-8")).get("senses", {})
    by_key = {s["natural_key"]: s for s in senses}
    applied = 0
    for key, patch in spec.items():
        s = by_key.get(key)
        if s is None:
            continue
        for field, value in patch.items():
            if field == "reason":
                continue
            s[field] = value
            s.setdefault("_overridden", []).append(field)
        applied += 1
    missing = [k for k in spec if k not in by_key]
    return applied, missing


def load_registry() -> dict:
    if REGISTRY.exists():
        return json.loads(REGISTRY.read_text(encoding="utf-8"))
    return {"version": 1, "next_seq": 1, "entries": {}, "tombstones": {}}


def apply_registry(senses: list[dict], today: str) -> dict:
    """只增不改：已登记的自然键沿用旧 ID，新键发新 ID，消失的键进墓碑。"""
    reg = load_registry()
    entries = reg["entries"]
    seen = set()
    minted = 0
    for s in senses:
        key = s["natural_key"]
        seen.add(key)
        rec = entries.get(key)
        if rec is None:
            rec = {
                "id": f"s{reg['next_seq']:06d}",
                "gloss_en_at_registration": s["gloss_en"],
                "first_seen": today,
            }
            reg["next_seq"] += 1
            entries[key] = rec
            minted += 1
        s["sense_id"] = rec["id"]

    gone = [k for k in entries if k not in seen]
    for k in gone:
        reg["tombstones"][k] = {**entries.pop(k), "retired": today}

    reg["_summary"] = {
        "active": len(entries),
        "minted_this_run": minted,
        "retired_this_run": len(gone),
        "tombstones": len(reg["tombstones"]),
    }
    return reg


def build_words(senses: list[dict]) -> list[dict]:
    index: dict[str, dict] = {}
    for s in senses:
        w = index.setdefault(
            s["headword"],
            {"headword": s["headword"], "pos_list": [], "levels": [], "sense_ids": []},
        )
        if s["pos"] not in w["pos_list"]:
            w["pos_list"].append(s["pos"])
        if s["level"] not in w["levels"]:
            w["levels"].append(s["level"])
        w["sense_ids"].append(s["sense_id"])
    for w in index.values():
        w["levels"].sort()
        w["min_level"] = w["levels"][0]
    return sorted(index.values(), key=lambda w: w["headword"].lower())


def main() -> int:
    from datetime import date

    today = date.today().isoformat()
    text = ensure_raw_text()
    senses, stats = parse(text)

    orphans = [s for s in senses if not s["headword"]]
    if orphans:
        print(f"! {len(orphans)} 条义项找不到所属词条，已丢弃", file=sys.stderr)
        senses = [s for s in senses if s["headword"]]

    senses, dup_runs = dedupe_repeated_runs(senses)
    senses, ghosts = drop_ghost_lines(senses)

    assign_natural_keys(senses)
    dup = len(senses) - len({s["natural_key"] for s in senses})
    if dup:
        print(f"! 自然键重复 {dup} 条", file=sys.stderr)
        return 1

    overridden, missing_overrides = apply_overrides(senses)
    if missing_overrides:
        print(
            f"! overrides.json 有 {len(missing_overrides)} 条自然键找不到："
            f"{missing_overrides}",
            file=sys.stderr,
        )

    reg = apply_registry(senses, today)
    REGISTRY.parent.mkdir(parents=True, exist_ok=True)
    REGISTRY.write_text(
        json.dumps(reg, ensure_ascii=False, indent=1, sort_keys=True), encoding="utf-8"
    )

    for s in senses:
        s.pop("_rest", None)
    words = build_words(senses)

    payload = {
        "meta": {
            "generated": today,
            "source_pdf": PDF.name,
            "stage": "1_extract",
            "counts": {
                "senses": len(senses),
                "words": len(words),
                "topics": len(stats["topics"]),
                "subsections": len(stats["subs"]),
                "headword_lines": stats["headwords"],
                "continuation_lines": stats["continuations"],
                "page_number_lines": stats["page_numbers"],
                "stray_fragments": len(stats["strays"]),
                "duplicate_runs_dropped": len(dup_runs),
                "ghost_lines_dropped": len(ghosts),
                "overrides_applied": overridden,
                "with_example": sum(1 for s in senses if s["example_en"]),
            },
            "by_level": {
                lv: sum(1 for s in senses if s["level"] == lv)
                for lv in ("A1", "A2", "B1", "B2", "C1", "C2")
            },
            "registry": reg["_summary"],
        },
        "words": words,
        "senses": senses,
        "dropped_stray_fragments": stats["strays"],
        "dropped_duplicate_runs": [
            {
                "page": s["page"],
                "headword": s["headword"],
                "pos": s["pos"],
                "level": s["level"],
                "gloss_en": s["gloss_en"],
                "example_en": s["example_en"],
            }
            for s in dup_runs
        ],
        "dropped_ghost_lines": [
            {
                "page": s["page"],
                "headword": s["headword"],
                "pos": s["pos"],
                "level": s["level"],
                "gloss_en": s["gloss_en"],
                "example_en": s["example_en"],
            }
            for s in ghosts
        ],
    }
    OUT.write_text(json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8")

    c = payload["meta"]["counts"]
    print(f"义项 {c['senses']} / 词形 {c['words']} / 带例句 {c['with_example']}")
    print(f"主题 {c['topics']} / 子分类 {c['subsections']} / 续行 {c['continuation_lines']}")
    print(f"分级 {payload['meta']['by_level']}")
    print(f"注册表 {reg['_summary']}")
    print(f"→ {OUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
