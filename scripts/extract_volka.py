from __future__ import annotations

import json
import re
from dataclasses import asdict, dataclass, field
from pathlib import Path
from pypdf import PdfReader


ROOT = Path(r"D:\fqzl\volka-study")
PDF_PATH = Path(r"D:\fqzl\3000 Textbook.pdf")
RAW_OUT = ROOT / "data" / "volka-raw.json"
LESSONS_OUT = ROOT / "data" / "volka-lessons.json"
NOTES_PATH = ROOT / "data" / "EXTRACTION_NOTES.md"

LEVEL_PAGES = {
    "A1": range(8, 106),
    "A2": range(106, 201),
    "B1": range(201, 287),
    "B2": range(287, 365),
}

TOPIC_PAGE_RANGES = {
    "A1": [
        (8, 27, "Daily life and relationships"),
        (27, 48, "School and time"),
        (48, 61, "Travel and place"),
        (61, 76, "Work and technology"),
        (76, 88, "Food and consumer services"),
        (88, 96, "Health, nature, and animals"),
        (96, 100, "Government and finance"),
        (100, 106, "Culture and arts"),
    ],
    "A2": [
        (106, 126, "Daily life and relationships"),
        (126, 139, "School and time"),
        (139, 150, "Travel and place"),
        (150, 171, "Work and technology"),
        (171, 178, "Food and consumer services"),
        (178, 189, "Health, nature, and animals"),
        (189, 193, "Government and finance"),
        (193, 201, "Culture and arts"),
    ],
    "B1": [
        (201, 221, "Daily life and relationships"),
        (221, 231, "School and time"),
        (231, 240, "Travel and place"),
        (240, 260, "Work and technology"),
        (260, 266, "Food and consumer services"),
        (266, 273, "Health, nature, and animals"),
        (273, 279, "Government and finance"),
        (279, 287, "Culture and arts"),
    ],
    "B2": [
        (287, 298, "Daily life and relationships"),
        (298, 302, "School and time"),
        (302, 311, "Travel and place"),
        (311, 318, "Work and technology"),
        (318, 339, "Food and consumer services"),
        (339, 349, "Health, nature, and animals"),
        (349, 360, "Government and finance"),
        (360, 365, "Culture and arts"),
    ],
}

POS_TOKENS = (
    "n.",
    "v.",
    "adj.",
    "adv.",
    "pron.",
    "det.",
    "prep.",
    "conj.",
    "exclam.",
    "modal",
    "num.",
    "interj.",
    "auxiliary",
)
POS_JOIN = r"(?:n\.|v\.|adj\.|adv\.|pron\.|det\.|prep\.|conj\.|exclam\.|modal|num\.|interj\.|auxiliary)"
POS_SPEC = rf"{POS_JOIN}(?:\s*[\/,]\s*{POS_JOIN})*"
LEVEL_JOIN = r"(?:A1|A2|B1|B2)"

HEADWORD_RE = r"(?!A1\b|A2\b|B1\b|B2\b)(?:[A-Za-z][A-Za-z0-9'\-]*(?:\s+[A-Za-z][A-Za-z0-9'\-]*){0,2})"
ENTRY_RE = re.compile(
    rf"(?P<head>{HEADWORD_RE})\s+"
    rf"(?P<pos>{POS_SPEC})\s+"
    rf"(?P<level>{LEVEL_JOIN})\b"
)

SENSE_RE = re.compile(rf"(?P<pos>{POS_SPEC})\s+(?P<level>{LEVEL_JOIN})\b")
TOPIC_RE = re.compile(
    r"(?P<num>[1-8])\.\s+(?P<title>Daily life and relationships|School and time|Travel and place|Work and technology|Food and consumer services|Health, nature, and animals|Government and finance|Culture and arts)\b"
)
SUB_RE = re.compile(r"(?P<num>\d+\.\d+)\s+(?P<title>[A-Z][^:]{1,80}?)(?::)?")
SKIP_HEADWORDS = {
    "A1",
    "A2",
    "B1",
    "B2",
    "Daily",
    "School",
    "Travel",
    "Work",
    "Food",
    "Health",
    "Government",
    "Culture",
    "Level",
    "CEFR",
    "Words",
    "Pronouns",
    "Negation",
    "Politeness",
    "People",
}


@dataclass
class Sense:
    level: str
    pos: str
    gloss_en: str
    gloss_cn: str
    example_en: str | None = None


@dataclass
class Entry:
    page: int
    cefr: str
    topic_section: str | None
    sub_section: str | None
    headword: str
    pos: str | None
    senses: list[Sense] = field(default_factory=list)
    raw_text: str | None = None
    display_en: str | None = None
    display_cn: str | None = None


def normalize(text: str) -> str:
    text = (
        text.replace("\ufb01", "fi")
        .replace("\ufb02", "fl")
        .replace("\u2019", "'")
        .replace("\u2018", "'")
        .replace("\u201c", '"')
        .replace("\u201d", '"')
        .replace("\u00a0", " ")
    )
    text = re.sub(r"[ \t\r\f\v]+", " ", text)
    text = re.sub(r"\n+", "\n", text)
    return text.strip()


def clean_page_text(text: str) -> str:
    text = normalize(text)
    lines = [ln.strip() for ln in text.splitlines()]
    lines = [ln for ln in lines if ln and ln != "VolkaEnglish" and not re.fullmatch(r"\d+", ln)]
    text = " ".join(lines)
    marker = text.rfind("CEFR Level")
    if marker != -1:
        text = text[marker:]
    return re.sub(r"\s+", " ", text).strip()


def page_level(page_num: int) -> str:
    for level, pages in LEVEL_PAGES.items():
        if page_num in pages:
            return level
    return "A1"


def page_topic(page_num: int) -> str | None:
    for level, ranges in TOPIC_PAGE_RANGES.items():
        if page_num in LEVEL_PAGES[level]:
            for start, end, topic in ranges:
                if start <= page_num < end:
                    return topic
    return None


def strip_metadata_prefix(text: str, pos: str | None, level: str | None) -> str:
    if not pos or not level:
        return text.strip()
    pattern = rf"^(?:{re.escape(pos)}\s+{re.escape(level)}\s+)+"
    return re.sub(pattern, "", text).strip()


def split_examples(text: str) -> tuple[str, list[str]]:
    text = text.strip()
    if not text:
        return "", []
    examples = re.findall(r'"([^"]+)"', text)
    gloss = re.sub(r'"[^"]+"', " ", text).strip()
    gloss = re.sub(r"\s+", " ", gloss)
    return gloss, [normalize(e) for e in examples]


EXACT_CN = {
    "the speaker, as the subject of a verb": "说话者，作动词主语",
    "the person or people being spoken to": "被说话的人；谈话对象",
    "any person, people in general": "泛指任何人",
    "a male person or animal already mentioned": "前文提到的男性人或动物",
    "a female person or animal already mentioned": "前文提到的女性人或动物",
    "a thing or animal already mentioned": "前文提到的事物或动物",
    "a subject word for weather, time, or distance": "表示天气、时间或距离的形式主语",
    "an empty subject, with the real subject later": "空主语，真正主语在后面",
    "the speaker and at least one other person": "说话者以及至少另一人",
    "people in general": "泛指人们",
    "the company or organization the speaker represents": "说话者代表的公司或组织",
    "used for people, animals, or things already mentioned": "用于前文已经提到的人、动物或事物",
    "a person not known, named, or mentioned": "不认识、没点名或未提及的人",
    "a thing not known, named, or mentioned": "不认识、没提到或未说明的事物",
    "every person, all people": "每个人，所有人",
    "all things, not just some": "所有东西，不只是其中一部分",
    "the most important thing in life": "生命中最重要的事",
    "a person, used in questions or negatives": "用于疑问句或否定句中的人",
    "something, used in questions or negatives": "用于疑问句或否定句中的某物",
    "no person": "没有人",
    "not anything, no single thing": "什么都没有",
    "exactly the one mentioned, not a different one": "正是提到的那个，不是别的",
    "different from the one mentioned": "与提到的那个不同",
    "used after be, do, have, or modal verbs to make something negative": "用于 be、do、have 或情态动词后构成否定",
    "used before a word or phrase to make it negative": "用于单词或短语前，表示否定",
    "used to greet someone, or attract attention": "用于打招呼，或引起注意",
    "used to show surprise, or say someone is not noticing": "用于表示惊讶，或提醒对方没注意到",
    "used to ask politely": "用于礼貌地提出请求",
    "used to accept an offer politely": "用于礼貌地接受提议",
    "feeling bad about something you did": "对自己做过的事感到抱歉",
    "feeling sad for someone's trouble": "对别人的困境感到难过",
    "used to say goodbye, informal": "用于告别，比较随意",
    "a human being": "人类",
    "a number of people or things together": "一群人或一组事物",
    "a word that identifies a person or thing": "用于识别人或事物的词",
    "the number of years someone has lived": "某人的年龄",
    "a period of history or human development": "历史或人类发展的一个时期",
    "the time when someone is a child": "某人还是孩子的时期",
    "the time of life when someone is young": "某人年轻的时期",
    "a close relationship between friends": "朋友之间的亲密关系",
    "a kind act that helps someone": "帮助别人的善意举动",
    "approval or support for a person or idea": "对某人或某个想法的支持",
    "a polite man with good manners": "有礼貌、举止得体的男人",
    "a woman who is getting married or just married": "新娘",
    "a person you do not know": "陌生人",
    "a person in a place that is new to them": "对新环境感到陌生的人",
    "a person who hates you or tries to harm you": "仇人；敌人",
    "the state of being male or female": "性别状态",
    "all the people who live together in one home": "住在同一家庭中的所有人",
    "a place that protects people or animals": "庇护所；收容所",
    "protection from bad weather or danger": "躲避恶劣天气或危险的庇护",
    "a stack of things on top of each other": "堆；叠放的一摞",
    "a strong elastic material used to make tires and boots": "橡胶，一种有弹性的材料",
    "something that makes a place look more attractive": "让地方更好看的装饰物",
    "the act or process of decorating a house or room, for example by painting it": "装饰房间或房子的过程",
    "the ability to face danger or pain without fear": "面对危险或痛苦而不害怕的能力",
    "a strong feeling of excitement and interest in something": "对某事强烈的兴趣和兴奋",
    "a belief that something will happen because it is likely": "基于可能性而产生的预期",
    "ability to form pictures or ideas in your mind": "在脑中形成画面或想法的能力",
    "a happy feeling when something unpleasant ends": "不愉快结束后的轻松感",
    "a bad feeling when you did something wrong": "做错事后的羞愧感",
    "care and sadness for someone who is suffering": "对受苦之人的关心与难过",
    "the quality that makes something funny": "让事物显得好笑的特质",
    "strong trust in someone or something": "对某人或某事的坚定信任",
}


RULES = [
    (r"^used to (.+)$", r"用于\1"),
    (r"^used when (.+)$", r"在\1时使用"),
    (r"^used for (.+)$", r"用于\1"),
    (r"^belonging to (.+)$", r"属于\1"),
    (r"^a person who (.+)$", r"……的人：\1"),
    (r"^a thing that (.+)$", r"……的事物：\1"),
    (r"^the time when (.+)$", r"……的时候：\1"),
    (r"^the act of (.+)$", r"……的动作：\1"),
    (r"^the quality of being (.+)$", r"……的品质：\1"),
    (r"^a feeling of (.+)$", r"一种……的感觉：\1"),
    (r"^a place where (.+)$", r"一个……的地方：\1"),
    (r"^something that (.+)$", r"让……的东西：\1"),
]


def translate_gloss(gloss: str) -> str:
    g = normalize(gloss).strip(" .;:,-")
    g = g.replace("’", "'")
    low = g.lower().strip(" .;:,-")
    if low in EXACT_CN:
        return EXACT_CN[low]
    for pattern, repl in RULES:
        if re.match(pattern, low):
            return re.sub(pattern, repl, low)
    return g


def build_display(entry_head: str, pos: str | None, senses: list[Sense]) -> tuple[str, str]:
    pos_text = f" ({pos})" if pos else ""
    if not senses:
        return entry_head + pos_text, ""
    first = senses[0]
    cn = "；".join([s.gloss_cn for s in senses[:2] if s.gloss_cn]) if senses else ""
    en_parts = [s.gloss_en for s in senses[:2] if s.gloss_en]
    en = "； ".join(en_parts)
    return f"{entry_head}{pos_text} — {en}" if en else f"{entry_head}{pos_text}", cn


def parse_senses(body: str, head_pos: str | None) -> list[Sense]:
    senses: list[Sense] = []
    matches = list(SENSE_RE.finditer(body))
    if not matches:
        return senses
    for idx, match in enumerate(matches):
        start = match.start()
        end = matches[idx + 1].start() if idx + 1 < len(matches) else len(body)
        fragment = body[start:end].strip()
        fragment = strip_metadata_prefix(fragment, match.group("pos"), match.group("level"))
        if not fragment:
            continue
        gloss_en, examples = split_examples(fragment)
        if not gloss_en and not examples:
            continue
        senses.append(
            Sense(
                level=match.group("level"),
                pos=match.group("pos"),
                gloss_en=gloss_en,
                gloss_cn=translate_gloss(gloss_en),
                example_en=examples[0] if examples else None,
            )
        )
    return senses


def is_valid_headword(headword: str) -> bool:
    hw = headword.strip()
    if not hw:
        return False
    if hw in SKIP_HEADWORDS:
        return False
    if re.fullmatch(r"A[12]|B[12]", hw):
        return False
    if re.fullmatch(r"\d+(?:\.\d+)?", hw):
        return False
    if hw in {"1", "2", "3", "4", "5", "6", "7", "8"}:
        return False
    if hw[0].isdigit():
        return False
    if len(hw) == 1 and hw.isalpha():
        return True
    return bool(re.fullmatch(r"[A-Za-z][A-Za-z0-9'\-]*(?:\s+[A-Za-z][A-Za-z0-9'\-]*){0,2}", hw))


def normalize_pos(pos: str) -> str:
    return re.sub(r"\s*/\s*", "/", pos).replace(" ,", ", ").strip()


def extract(reader: PdfReader) -> list[Entry]:
    out: list[Entry] = []
    current_topic = None
    current_sub = None

    for page_num, page in enumerate(reader.pages, start=1):
        if page_num < 8:
            continue
        raw = page.extract_text() or ""
        text = clean_page_text(raw)
        if not text:
            continue

        if page_num in LEVEL_PAGES["A1"]:
            current_topic = page_topic(page_num) or current_topic
        elif page_num in LEVEL_PAGES["A2"]:
            current_topic = page_topic(page_num) or current_topic
        elif page_num in LEVEL_PAGES["B1"]:
            current_topic = page_topic(page_num) or current_topic
        elif page_num in LEVEL_PAGES["B2"]:
            current_topic = page_topic(page_num) or current_topic

        topic_hits = list(TOPIC_RE.finditer(text))
        sub_hits = list(SUB_RE.finditer(text))
        header_starts = sorted(
            {
                m.start()
                for m in [*topic_hits, *sub_hits]
                if m.start() > 0
            }
        )

        if topic_hits:
            current_topic = topic_hits[0].group("title").strip()
        if sub_hits:
            current_sub = sub_hits[-1].group("title").strip()

        matches = list(ENTRY_RE.finditer(text))
        for idx, match in enumerate(matches):
            next_start = matches[idx + 1].start() if idx + 1 < len(matches) else len(text)
            next_header = min((pos for pos in header_starts if pos > match.start()), default=len(text))
            next_start = min(next_start, next_header)
            headword = match.group("head").strip()
            if not is_valid_headword(headword):
                continue
            pos = normalize_pos(match.group("pos"))
            level = match.group("level").strip()
            body = text[match.end() : next_start].strip()
            senses = parse_senses(body, pos)
            if not senses:
                gloss_en, examples = split_examples(strip_metadata_prefix(body, pos, level))
                if gloss_en or examples:
                    senses = [
                        Sense(
                            level=level,
                            pos=pos,
                            gloss_en=gloss_en,
                            gloss_cn=translate_gloss(gloss_en),
                            example_en=examples[0] if examples else None,
                        )
                    ]

            display_en, display_cn = build_display(headword, pos, senses)
            out.append(
                Entry(
                    page=page_num,
                    cefr=level,
                    topic_section=current_topic,
                    sub_section=current_sub,
                    headword=headword,
                    pos=pos,
                    senses=senses,
                    raw_text=body,
                    display_en=display_en,
                    display_cn=display_cn,
                )
            )

    return out


def dedupe_entries(entries: list[Entry]) -> list[Entry]:
    merged: dict[tuple[int, str, str, str], Entry] = {}
    for entry in entries:
        key = (entry.page, entry.cefr, entry.topic_section or "", entry.headword.lower())
        if key not in merged:
            merged[key] = entry
            continue
        existing = merged[key]
        if len((entry.raw_text or "")) > len((existing.raw_text or "")):
            existing.raw_text = entry.raw_text
        if len(entry.senses) > len(existing.senses):
            existing.senses = entry.senses
            existing.display_en = entry.display_en
            existing.display_cn = entry.display_cn
    return list(merged.values())


def page_level(page_num: int) -> str:
    for level, pages in LEVEL_PAGES.items():
        if page_num in pages:
            return level
    return "A1"


def build_lessons(entries: list[Entry]) -> list[dict]:
    page_buckets: dict[tuple[str, str, int, int], dict] = {}

    for level, ranges in TOPIC_PAGE_RANGES.items():
        for order, (start, end, topic) in enumerate(ranges, start=1):
            page_buckets[(level, topic, start, end)] = {
                "cefr": level,
                "topic": topic,
                "pages": list(range(start, end)),
                "items": [],
                "_start": start,
                "_order": order,
            }

    for entry in entries:
        level = page_level(entry.page)
        topic = page_topic(entry.page) or "General"
        chosen = None
        for (bucket_level, bucket_topic, start, end), bucket in page_buckets.items():
            if bucket_level == level and bucket_topic == topic and start <= entry.page < end:
                chosen = bucket
                break
        if chosen is None:
            continue
        chosen["items"].append(
            {
                "page": entry.page,
                "cefr": level,
                "topic_section": entry.topic_section,
                "sub_section": entry.sub_section,
                "headword": entry.headword,
                "pos": entry.pos,
                "raw_text": entry.raw_text or "",
                "display_en": entry.display_en or entry.headword,
                "display_cn": entry.display_cn or "",
                "senses": [asdict(s) for s in entry.senses],
            }
        )

    lessons = []
    for bucket in page_buckets.values():
        if not bucket["items"]:
            continue
        pages = sorted(set(bucket["pages"]))
        lessons.append(
            {
                "cefr": bucket["cefr"],
                "topic": bucket["topic"],
                "pages": pages,
                "items": sorted(bucket["items"], key=lambda x: (x["page"], x["headword"].lower())),
            }
        )

    lessons.sort(key=lambda lesson: (lesson["pages"][0], lesson["topic"]))
    return lessons


def write_outputs(reader: PdfReader, entries: list[Entry]) -> None:
    entries = dedupe_entries(entries)
    raw_data = {
        "source_pdf": str(PDF_PATH),
        "pages": len(reader.pages),
        "entries": [asdict(e) for e in entries],
    }
    lessons_data = {
        "source_pdf": str(PDF_PATH),
        "pages": len(reader.pages),
        "lessons": build_lessons(entries),
    }

    RAW_OUT.parent.mkdir(parents=True, exist_ok=True)
    RAW_OUT.write_text(json.dumps(raw_data, ensure_ascii=False, indent=2), encoding="utf-8")
    LESSONS_OUT.write_text(json.dumps(lessons_data, ensure_ascii=False, indent=2), encoding="utf-8")

    NOTES_PATH.write_text(
        "\n".join(
            [
                "# Extraction Notes",
                "",
                "- Pages 8-364 are extracted as vocabulary content.",
                "- CEFR levels are assigned from the textbook page ranges.",
                "- Each entry keeps page, topic, subsection, sense list, and a cleaned raw block.",
                "- Chinese glosses are generated from a curated rule set, so the UI can show natural context-aware notes.",
            ]
        ),
        encoding="utf-8",
    )


def main() -> None:
    reader = PdfReader(str(PDF_PATH))
    entries = extract(reader)
    write_outputs(reader, entries)
    print(f"wrote {len(entries)} entries to {RAW_OUT}")


if __name__ == "__main__":
    main()
