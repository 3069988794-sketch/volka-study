import { promises as fs } from "node:fs";
import path from "node:path";
import type { Sense, SenseData } from "./types";

type RawSense = Partial<Sense> & {
  sense_id?: string;
};

type RawPayload = {
  senses?: RawSense[];
  meta?: {
    cn_counts?: {
      complete?: number;
    };
  };
};

const PRIMARY_PATH = path.join(process.cwd(), "data", "senses.json");
const FALLBACK_PATH = path.join(process.cwd(), "pipeline", "_work", "senses_cn_partial.json");

function asText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function normalizeSense(raw: RawSense, index: number): Sense {
  return {
    sense_id: asText(raw.sense_id) || `dev-${index}`,
    headword: asText(raw.headword) || "untitled",
    pos: asText(raw.pos),
    level: asText(raw.level) || "A1",
    gloss_en: asText(raw.gloss_en),
    gloss_cn: asText(raw.gloss_cn),
    example_en: asText(raw.example_en),
    example_cn: asText(raw.example_cn),
    ipa: asText(raw.ipa),
    chunk: asText(raw.chunk),
    priority: asText(raw.priority) || "T0",
    topic: asText(raw.topic),
    sub_name: asText(raw.sub_name)
  };
}

async function readJson(filePath: string): Promise<RawPayload> {
  const source = await fs.readFile(filePath, "utf8");
  return JSON.parse(source) as RawPayload;
}

export async function loadSenseData(): Promise<SenseData> {
  let payload: RawPayload;
  let isFallback = false;

  try {
    payload = await readJson(PRIMARY_PATH);
  } catch {
    payload = await readJson(FALLBACK_PATH);
    isFallback = true;
  }

  const senses = (payload.senses ?? []).map(normalizeSense);
  const completeCn =
    payload.meta?.cn_counts?.complete ??
    senses.filter((sense) => sense.gloss_cn.trim() && sense.example_cn.trim()).length;

  return {
    senses,
    isFallback,
    notice: isFallback ? "数据仍在补齐" : null,
    counts: {
      total: senses.length,
      completeCn
    }
  };
}
