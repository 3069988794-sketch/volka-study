"""4_tts.py — edge-tts 批量生成音频（PLAN.md 3.5 / M0.5）

输入：_work/senses_enriched.json
产出：data/audio/<hash>.mp3、data/audio_index.json、_work/tts_failures.json

每条义项两类片段：词形单独一条 + 例句一条。按文本精确去重，同一文本只生成一个文件。

文件名 = sha1(text.strip().encode("utf-8")).hexdigest()[:16] + ".mp3"
用文本哈希而不是 sense_id：改元数据、修释义都不会让音频失效（PLAN.md 3.5、3.4 第 2 条）。

音色 = VOICES[int(hash, 16) % 2]，由内容哈希决定，同一文本永远同一音色，与生成顺序、
与是否断点续跑都无关。

断点续跑：目标文件存在且 >= MIN_BYTES 就跳过；小于 1KB 的是失败的合成结果，删掉重试。
"""
from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import random
import sys
import time
from dataclasses import dataclass
from pathlib import Path

import edge_tts

# Windows 控制台默认 GBK，打印 IPA、括注里的非 ASCII 会直接崩，先把 stdout 换成 UTF-8。
sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent
WORK = ROOT / "pipeline" / "_work"
SRC = WORK / "senses_enriched.json"
AUDIO_DIR = ROOT / "data" / "audio"
INDEX = ROOT / "data" / "audio_index.json"
FAILURES = WORK / "tts_failures.json"

VOICES = ("en-US-AriaNeural", "en-US-GuyNeural")
HASH_LEN = 16
MIN_BYTES = 1024  # 低于这个大小的 mp3 是没合成出声音的空壳
ATTEMPTS = 3
BACKOFF_BASE = 1.5
PROGRESS_EVERY = 100


def text_hash(text: str) -> str:
    """前端契约：sha1(text.strip() 的 utf-8 字节) 的十六进制前 16 位。"""
    return hashlib.sha1(text.strip().encode("utf-8")).hexdigest()[:HASH_LEN]


def voice_for(hash_hex: str) -> str:
    return VOICES[int(hash_hex, 16) % 2]


@dataclass
class Clip:
    hash: str
    text: str
    kind: str  # "word" | "example"
    voice: str


def word_text(sense: dict) -> str:
    """朗读用的词形。

    原书为区分同形词加了后缀和括注（`ring1`、`kind (caring)`、`light (from the sun/a lamp)`），
    直接念会念成 "ring one"、把括注也念出来。`lemma` 正是 2_enrich.py 剥干净的基本形，
    2998 个 headword 里只有 51 个带这类记号，其余 lemma 与 headword 完全一致。
    """
    return (sense.get("lemma") or sense["headword"]).strip()


def build_plan(senses: list[dict], only: str) -> tuple[dict[str, Clip], dict[str, dict[str, str]]]:
    """→ (hash → Clip 去重表, sense_id → {kind: hash})。"""
    clips: dict[str, Clip] = {}
    by_sense: dict[str, dict[str, str]] = {}
    for sense in senses:
        pairs: list[tuple[str, str]] = []
        if only in ("word", "both"):
            pairs.append(("word", word_text(sense)))
        if only in ("example", "both"):
            pairs.append(("example", sense.get("example_en", "").strip()))
        for kind, text in pairs:
            if not text:
                continue
            h = text_hash(text)
            if h not in clips:
                clips[h] = Clip(hash=h, text=text.strip(), kind=kind, voice=voice_for(h))
            by_sense.setdefault(sense["sense_id"], {})[kind] = h
    return clips, by_sense


def existing_bytes(hash_hex: str) -> int:
    """已生成且可用的文件大小；不存在或过小返回 0（过小的顺手删掉，等重生成）。"""
    path = AUDIO_DIR / f"{hash_hex}.mp3"
    try:
        size = path.stat().st_size
    except OSError:
        return 0
    if size < MIN_BYTES:
        path.unlink(missing_ok=True)
        return 0
    return size


async def synthesize(clip: Clip) -> bytes:
    """整段先收进内存，校验通过再落盘，磁盘上不会出现半截文件。"""
    comm = edge_tts.Communicate(clip.text, clip.voice)
    buf = bytearray()
    async for chunk in comm.stream():
        if chunk["type"] == "audio" and chunk.get("data"):
            buf.extend(chunk["data"])
    return bytes(buf)


async def generate(clip: Clip) -> tuple[int, str | None]:
    """→ (bytes, 最后一次错误)。三次重试，指数退避，单条失败绝不中断整轮。"""
    last_err = "unknown error"
    tmp = AUDIO_DIR / f"{clip.hash}.part"
    for attempt in range(1, ATTEMPTS + 1):
        try:
            audio = await synthesize(clip)
            if len(audio) < MIN_BYTES:
                raise RuntimeError(f"mp3 too small ({len(audio)} bytes) — 合成为空")
            tmp.write_bytes(audio)
            tmp.replace(AUDIO_DIR / f"{clip.hash}.mp3")
            return len(audio), None
        except Exception as exc:  # edge-tts 走网络，任何异常都只影响这一条
            last_err = f"{type(exc).__name__}: {exc}"
            tmp.unlink(missing_ok=True)
            if attempt < ATTEMPTS:
                await asyncio.sleep(BACKOFF_BASE ** attempt + random.uniform(0, 0.4))
    return 0, last_err


async def run_queue(pending: list[Clip], concurrency: int, skipped: int) -> list[dict]:
    queue: asyncio.Queue[Clip] = asyncio.Queue()
    for clip in pending:
        queue.put_nowait(clip)

    total = len(pending)
    state = {"done": 0, "failed": 0, "bytes": 0}
    failures: list[dict] = []
    started = time.monotonic()

    async def worker() -> None:
        while True:
            try:
                clip = queue.get_nowait()
            except asyncio.QueueEmpty:
                return
            size, err = await generate(clip)
            if err is None:
                state["done"] += 1
                state["bytes"] += size
            else:
                state["failed"] += 1
                failures.append(
                    {
                        "hash": clip.hash,
                        "kind": clip.kind,
                        "voice": clip.voice,
                        "text": clip.text,
                        "attempts": ATTEMPTS,
                        "error": err,
                    }
                )
                print(f"  ! {clip.hash} [{clip.kind}] {clip.text[:60]!r} → {err}", flush=True)
            handled = state["done"] + state["failed"]
            if handled % PROGRESS_EVERY == 0 or handled == total:
                rate = handled / max(time.monotonic() - started, 0.001)
                print(
                    f"  done {state['done']} / skipped {skipped} / failed {state['failed']}"
                    f" / remaining {total - handled}"
                    f" | {state['bytes'] / 1e6:.1f} MB | {rate:.1f}/s",
                    flush=True,
                )

    await asyncio.gather(*(worker() for _ in range(max(1, concurrency))))
    return failures


def write_index(clips: dict[str, Clip], by_sense_all: dict[str, dict[str, str]]) -> tuple[int, int]:
    """只收录磁盘上真实存在的片段，前端不用自己算哈希。放在 data/ 而不是 data/audio/：
    那个目录由 route handler 直接对外提供，里面只能有 mp3。"""
    files: dict[str, dict] = {}
    total_bytes = 0
    for h, clip in clips.items():
        size = existing_bytes(h)
        if not size:
            continue
        files[h] = {"text": clip.text, "voice": clip.voice, "kind": clip.kind, "bytes": size}
        total_bytes += size
    by_sense = {}
    for sense_id, kinds in by_sense_all.items():
        got = {k: v for k, v in kinds.items() if v in files}
        if got:
            by_sense[sense_id] = got
    payload = {"version": 1, "hash": "sha1_16", "by_sense": by_sense, "files": files}
    INDEX.parent.mkdir(parents=True, exist_ok=True)
    INDEX.write_text(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8"
    )
    return len(files), total_bytes


def write_failures(failures: list[dict], considered: set[str]) -> None:
    """本轮范围内的失败覆盖写，范围外（比如上一轮 --only example 的失败）原样留着。"""
    previous = []
    if FAILURES.exists():
        try:
            old = json.loads(FAILURES.read_text(encoding="utf-8"))
            previous = [f for f in old.get("items", []) if f.get("hash") not in considered]
        except (json.JSONDecodeError, OSError):
            previous = []
    # 之前失败、这轮已经成功的不再列出
    previous = [f for f in previous if not existing_bytes(f.get("hash", ""))]
    items = previous + failures
    FAILURES.parent.mkdir(parents=True, exist_ok=True)
    FAILURES.write_text(
        json.dumps(
            {"generated_at": time.strftime("%Y-%m-%dT%H:%M:%S"), "count": len(items), "items": items},
            ensure_ascii=False,
            indent=1,
        ),
        encoding="utf-8",
    )


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    ap = argparse.ArgumentParser(description="edge-tts 批量生成词形与例句音频")
    ap.add_argument("--limit", type=int, default=0, help="本轮最多生成多少条（抽样跑）")
    ap.add_argument("--only", choices=("word", "example", "both"), default="both")
    ap.add_argument("--concurrency", type=int, default=8)
    ap.add_argument("--dry-run", action="store_true", help="只报数，不生成任何文件")
    return ap.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    payload = json.loads(SRC.read_text(encoding="utf-8"))
    senses = payload["senses"]

    clips_all, by_sense_all = build_plan(senses, "both")
    clips_run, _ = build_plan(senses, args.only)

    have: list[Clip] = []
    pending: list[Clip] = []
    for clip in clips_run.values():
        (have if existing_bytes(clip.hash) else pending).append(clip)

    n_word = sum(1 for c in clips_run.values() if c.kind == "word")
    n_example = len(clips_run) - n_word
    aria = sum(1 for c in clips_run.values() if c.voice == VOICES[0])
    print(f"义项 {len(senses)} | 本轮 only={args.only} 去重后唯一文本 {len(clips_run)}"
          f"（词形 {n_word} + 例句 {n_example}）")
    print(f"全库唯一文本 {len(clips_all)} → 预期 mp3 文件数 {len(clips_all)}")
    print(f"音色分配 {VOICES[0]} {aria} / {VOICES[1]} {len(clips_run) - aria}")
    print(f"已存在可用 {len(have)} | 待生成 {len(pending)}")

    if args.dry_run:
        print("--dry-run：不生成、不写索引、不写失败清单")
        return 0

    AUDIO_DIR.mkdir(parents=True, exist_ok=True)
    if args.limit and args.limit < len(pending):
        pending = pending[: args.limit]
        print(f"--limit {args.limit}：本轮只跑 {len(pending)} 条")

    failures: list[dict] = []
    if pending:
        started = time.monotonic()
        failures = asyncio.run(run_queue(pending, args.concurrency, len(have)))
        print(f"本轮耗时 {time.monotonic() - started:.1f}s")
    else:
        print("没有待生成的片段，跳过合成")

    write_failures(failures, {c.hash for c in pending})
    n_files, total_bytes = write_index(clips_all, by_sense_all)
    print(f"→ {INDEX}：{n_files} 个片段，{total_bytes / 1e6:.1f} MB")
    print(f"→ {FAILURES}：本轮失败 {len(failures)}")
    remaining = sum(1 for c in clips_run.values() if not existing_bytes(c.hash))
    print(f"本轮范围内仍缺 {remaining} 条")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
