"""Auto-translate Chinese gap shards without touching the main cache.

Writes pipeline/_work/agent_translations/part_auto_mt_001.json by default:
{"translations": {"sense_id": {"gloss_cn": "...", "example_cn": "..."}}}

The script is restartable: existing completed sense_id entries in the output
shard are skipped, and the shard is saved atomically after each chunk.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import random
import re
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Protocol


ROOT = Path(__file__).resolve().parent.parent
WORK = ROOT / "pipeline" / "_work"
GAPS = WORK / "translation_gaps.json"
OUT_DIR = WORK / "agent_translations"
DEFAULT_OUT = OUT_DIR / "part_auto_mt_001.json"
PAIR_MARKER = "@@9527@@"
PAIR_MARKER_RE = re.compile(r"@\s*@\s*9527\s*@\s*@")


class Translator(Protocol):
    def translate_many(self, texts: list[str]) -> list[str]:
        ...


def load_json(path: Path, default: Any) -> Any:
    if not path.exists():
        return default
    return json.loads(path.read_text(encoding="utf-8"))


def dump_json_atomic(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8")
    tmp.replace(path)


def load_existing(path: Path) -> dict[str, dict[str, str]]:
    raw = load_json(path, {})
    translations = raw.get("translations", {}) if isinstance(raw, dict) else {}
    out: dict[str, dict[str, str]] = {}
    for sense_id, rec in translations.items():
        if not isinstance(rec, dict):
            continue
        gloss_cn = str(rec.get("gloss_cn") or "").strip()
        example_cn = str(rec.get("example_cn") or "").strip()
        if gloss_cn and example_cn:
            out[str(sense_id)] = {"gloss_cn": gloss_cn, "example_cn": example_cn}
    return out


def errors_path_for(path: Path) -> Path:
    return path.with_suffix(path.suffix + ".errors.json")


def load_errors(path: Path) -> dict[str, str]:
    raw = load_json(errors_path_for(path), {})
    errors = raw.get("errors", {}) if isinstance(raw, dict) else {}
    return {str(k): str(v) for k, v in errors.items()} if isinstance(errors, dict) else {}


def dump_errors(path: Path, errors: dict[str, str]) -> None:
    if errors:
        dump_json_atomic(errors_path_for(path), {"errors": errors})
        return
    error_path = errors_path_for(path)
    if error_path.exists():
        error_path.unlink()


def build_pending_items(
    gaps: list[dict[str, Any]], existing: dict[str, dict[str, str]], limit: int | None
) -> list[dict[str, str]]:
    pending: list[dict[str, str]] = []
    for gap in gaps:
        sense_id = str(gap.get("sense_id") or "").strip()
        gloss_en = str(gap.get("gloss_en") or "").strip()
        example_en = str(gap.get("example_en") or "").strip()
        if not sense_id or not gloss_en or not example_en or sense_id in existing:
            continue
        pending.append({"sense_id": sense_id, "gloss_en": gloss_en, "example_en": example_en})
        if limit is not None and len(pending) >= limit:
            break
    return pending


class MockTranslator:
    """Offline smoke-test translator for producing a runnable sample shard."""

    def translate_many(self, texts: list[str]) -> list[str]:
        return [f"【机器样例】{text}" for text in texts]


class GoogleTranslator:
    def __init__(self, retries: int, timeout: float, backoff: float) -> None:
        self.retries = retries
        self.timeout = timeout
        self.backoff = backoff

    def translate_many(self, texts: list[str]) -> list[str]:
        return [self._translate_one(text) for text in texts]

    def _translate_one(self, text: str) -> str:
        params = urllib.parse.urlencode(
            {
                "client": "gtx",
                "sl": "en",
                "tl": "zh-CN",
                "dt": "t",
                "q": text,
            }
        )
        url = f"https://translate.googleapis.com/translate_a/single?{params}"
        last_error: Exception | None = None
        for attempt in range(1, self.retries + 1):
            try:
                request = urllib.request.Request(url, headers={"User-Agent": "volka-study-cn-mt/1.0"})
                with urllib.request.urlopen(request, timeout=self.timeout) as response:
                    payload = json.loads(response.read().decode("utf-8"))
                translated = "".join(part[0] for part in payload[0] if part and part[0])
                translated = clean_translation(translated)
                if translated:
                    return translated
                raise ValueError("empty translation")
            except Exception as exc:  # urllib exposes several transient exception types.
                last_error = exc
                if attempt >= self.retries:
                    break
                sleep_for = self.backoff * attempt + random.uniform(0, 0.25)
                time.sleep(sleep_for)
        raise RuntimeError(f"translation failed after {self.retries} attempts: {text!r}") from last_error


def parse_mymemory_payload(payload: dict[str, Any]) -> str:
    status = int(payload.get("responseStatus") or 0)
    if status and status != 200:
        details = payload.get("responseDetails") or payload.get("exception_code") or "unknown error"
        raise RuntimeError(f"MyMemory response {status}: {details}")
    translated = str((payload.get("responseData") or {}).get("translatedText") or "").strip()
    if not translated:
        raise RuntimeError("MyMemory response did not include translatedText")
    return clean_translation(translated)


class MyMemoryTranslator:
    def __init__(self, retries: int, timeout: float, backoff: float) -> None:
        self.retries = retries
        self.timeout = timeout
        self.backoff = backoff

    def translate_many(self, texts: list[str]) -> list[str]:
        return [self._translate_one(text) for text in texts]

    def translate_pairs(self, items: list[dict[str, str]]) -> list[tuple[str, str]]:
        out: list[tuple[str, str]] = []
        for item in items:
            combined = f"{item['gloss_en']}\n{PAIR_MARKER}\n{item['example_en']}"
            out.append(split_pair_translation(self._translate_one(combined)))
        return out

    def _translate_one(self, text: str) -> str:
        params = urllib.parse.urlencode({"q": text, "langpair": "en|zh-CN"})
        url = f"https://api.mymemory.translated.net/get?{params}"
        last_error: Exception | None = None
        for attempt in range(1, self.retries + 1):
            try:
                request = urllib.request.Request(url, headers={"User-Agent": "volka-study-cn-mt/1.0"})
                with urllib.request.urlopen(request, timeout=self.timeout) as response:
                    payload = json.loads(response.read().decode("utf-8"))
                return parse_mymemory_payload(payload)
            except Exception as exc:
                last_error = exc
                if attempt >= self.retries:
                    break
                sleep_for = self.backoff * attempt + random.uniform(0, 0.25)
                time.sleep(sleep_for)
        raise RuntimeError(f"translation failed after {self.retries} attempts: {text!r}") from last_error


class BaiduTranslator:
    """Baidu Fanyi API — works in mainland China, free tier: 2M chars/month."""

    API_URL = "https://fanyi-api.baidu.com/api/trans/vip/translate"

    def __init__(self, app_id: str, secret_key: str, retries: int, timeout: float, backoff: float) -> None:
        self.app_id = app_id
        self.secret_key = secret_key
        self.retries = retries
        self.timeout = timeout
        self.backoff = backoff

    def _sign(self, q: str, salt: str) -> str:
        raw = self.app_id + q + salt + self.secret_key
        return hashlib.md5(raw.encode("utf-8")).hexdigest()

    def translate_many(self, texts: list[str]) -> list[str]:
        return [self._translate_one(t) for t in texts]

    def _translate_one(self, text: str) -> str:
        last_error: Exception | None = None
        for attempt in range(1, self.retries + 1):
            try:
                salt = str(random.randint(10000, 99999))
                params = urllib.parse.urlencode({
                    "q": text, "from": "en", "to": "zh",
                    "appid": self.app_id, "salt": salt,
                    "sign": self._sign(text, salt),
                })
                req = urllib.request.Request(
                    self.API_URL,
                    data=params.encode("utf-8"),
                    method="POST",
                    headers={"Content-Type": "application/x-www-form-urlencoded"},
                )
                with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                    payload = json.loads(resp.read().decode("utf-8"))
                if "error_code" in payload:
                    raise RuntimeError(f"Baidu error {payload['error_code']}: {payload.get('error_msg')}")
                translated = "".join(r["dst"] for r in payload["trans_result"])
                translated = clean_translation(translated)
                if translated:
                    return translated
                raise ValueError("empty translation")
            except Exception as exc:
                last_error = exc
                if attempt >= self.retries:
                    break
                time.sleep(self.backoff * attempt + random.uniform(0, 0.25))
        raise RuntimeError(f"Baidu translation failed after {self.retries} attempts: {text!r}") from last_error


def clean_translation(text: str) -> str:
    return " ".join(text.replace("。.", "。").strip().split())


def split_pair_translation(text: str) -> tuple[str, str]:
    parts = PAIR_MARKER_RE.split(text, maxsplit=1)
    if len(parts) != 2:
        raise RuntimeError(f"pair translation marker missing: {text!r}")
    return clean_translation(parts[0]), clean_translation(parts[1])


def translate_items(
    items: list[dict[str, str]],
    translator: Translator,
    output_path: Path,
    chunk_size: int,
    delay_seconds: float,
    continue_on_error: bool = False,
) -> int:
    existing = load_existing(output_path)
    errors = load_errors(output_path)
    total_written = 0
    for index in range(0, len(items), chunk_size):
        chunk = [item for item in items[index : index + chunk_size] if item["sense_id"] not in existing]
        if not chunk:
            continue
        if hasattr(translator, "translate_pairs"):
            pairs = []
            failed: set[str] = set()
            for item in chunk:
                try:
                    pairs.extend(translator.translate_pairs([item]))  # type: ignore[attr-defined]
                except Exception as exc:
                    if not continue_on_error:
                        raise
                    failed.add(item["sense_id"])
                    errors[item["sense_id"]] = str(exc)
                    dump_errors(output_path, errors)
                    print(f"! 翻译失败 {item['sense_id']}: {exc}", file=sys.stderr, flush=True)
            chunk = [item for item in chunk if item["sense_id"] not in failed]
        else:
            texts: list[str] = []
            for item in chunk:
                texts.extend([item["gloss_en"], item["example_en"]])
            try:
                translated = translator.translate_many(texts)
            except Exception as exc:
                if not continue_on_error:
                    raise
                for item in chunk:
                    errors[item["sense_id"]] = str(exc)
                dump_errors(output_path, errors)
                continue
            if len(translated) != len(texts):
                raise RuntimeError(f"translator returned {len(translated)} strings for {len(texts)} inputs")
            pairs = list(zip(translated[0::2], translated[1::2]))
        for item, pair in zip(chunk, pairs):
            existing[item["sense_id"]] = {
                "gloss_cn": clean_translation(pair[0]),
                "example_cn": clean_translation(pair[1]),
            }
            errors.pop(item["sense_id"], None)
        dump_json_atomic(output_path, {"translations": existing})
        dump_errors(output_path, errors)
        total_written += len(chunk)
        done = len(existing)
        remaining = len([i for i in items[index + chunk_size:] if i["sense_id"] not in existing])
        grand_total = done + remaining
        pct = int(done / grand_total * 100) if grand_total > 0 else 100
        last_id = chunk[-1]["sense_id"] if chunk else "(全部失败)"
        print(f"[{done} 已完成 / 剩余约 {remaining}] {pct}% — 最近: {last_id}", flush=True)
        if delay_seconds > 0:
            time.sleep(delay_seconds)
    return total_written


def make_translator(args: argparse.Namespace) -> Translator:
    if args.backend == "mock":
        return MockTranslator()
    if args.backend == "baidu":
        if not args.baidu_appid or not args.baidu_key:
            print("! --baidu-appid 和 --baidu-key 必填", file=sys.stderr)
            raise SystemExit(2)
        return BaiduTranslator(
            app_id=args.baidu_appid, secret_key=args.baidu_key,
            retries=args.retries, timeout=args.timeout, backoff=args.backoff,
        )
    if args.backend == "mymemory":
        return MyMemoryTranslator(retries=args.retries, timeout=args.timeout, backoff=args.backoff)
    return GoogleTranslator(retries=args.retries, timeout=args.timeout, backoff=args.backoff)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--gaps", type=Path, default=GAPS)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    parser.add_argument("--backend", choices=["google", "mymemory", "mock", "baidu"], default="mymemory")
    parser.add_argument("--baidu-appid", default="", help="百度翻译 APP ID")
    parser.add_argument("--baidu-key", default="", help="百度翻译密钥")
    parser.add_argument("--limit", type=int, default=None)
    parser.add_argument("--chunk-size", type=int, default=20)
    parser.add_argument("--delay", type=float, default=0.35)
    parser.add_argument("--retries", type=int, default=4)
    parser.add_argument("--timeout", type=float, default=20)
    parser.add_argument("--backoff", type=float, default=1.5)
    parser.add_argument("--continue-on-error", action="store_true")
    args = parser.parse_args(argv)

    if args.chunk_size <= 0:
        print("! --chunk-size must be positive", file=sys.stderr)
        return 2
    gap_payload = load_json(args.gaps, {})
    gaps = gap_payload.get("gaps", []) if isinstance(gap_payload, dict) else []
    existing = load_existing(args.out)
    pending = build_pending_items(gaps, existing=existing, limit=args.limit)
    if not pending:
        print(f"nothing to do: {len(existing)} complete translations already in {args.out}")
        return 0

    translator = make_translator(args)
    written = translate_items(
        pending,
        translator=translator,
        output_path=args.out,
        chunk_size=args.chunk_size,
        delay_seconds=args.delay,
        continue_on_error=args.continue_on_error,
    )
    final_count = len(load_existing(args.out))
    print(f"wrote {written}; shard now has {final_count} complete translations -> {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
