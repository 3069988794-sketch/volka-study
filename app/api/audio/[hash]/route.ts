/**
 * Serves `data/audio/<hash>.mp3`.
 *
 * The clips live in `data/` rather than `public/` on purpose: a few hundred MB
 * under `public/` would thrash the dev file watcher. That is why this route
 * exists at all.
 */

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { resolveAudioFilePath } from "@/lib/audio-index";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ hash: string }> };

const IMMUTABLE = "public, max-age=31536000, immutable";

function jsonError(status: number, error: string, hash?: string): Response {
  return Response.json(
    { error, ...(hash === undefined ? {} : { hash }) },
    { status, headers: { "Cache-Control": "no-store" } }
  );
}

type ParsedRange = { start: number; end: number } | "unsatisfiable" | null;

/**
 * Parse a single-range `bytes=` header. Multi-range and malformed headers
 * return `null`, which means "ignore the header and send the whole file" — an
 * allowed response per RFC 9110.
 */
function parseRange(header: string | null, size: number): ParsedRange {
  if (!header) {
    return null;
  }

  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) {
    return null;
  }

  const [, rawStart, rawEnd] = match;
  if (rawStart === "" && rawEnd === "") {
    return null;
  }

  let start: number;
  let end: number;

  if (rawStart === "") {
    // Suffix range: the last N bytes.
    const suffix = Number(rawEnd);
    if (suffix <= 0) {
      return "unsatisfiable";
    }
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === "" ? size - 1 : Math.min(Number(rawEnd), size - 1);
  }

  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
    return "unsatisfiable";
  }

  return { start, end };
}

/** Stream instead of buffering: some example clips are hundreds of KB each. */
function fileStream(filePath: string, start: number, end: number): ReadableStream<Uint8Array> {
  const nodeStream = createReadStream(filePath, { start, end });
  return Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>;
}

async function handle(request: Request, context: RouteContext, withBody: boolean) {
  const { hash } = await context.params;

  // Validate before any path work: this is the path-traversal boundary.
  const filePath = resolveAudioFilePath(hash);
  if (!filePath) {
    return jsonError(400, "invalid_hash");
  }

  let size: number;
  try {
    const stats = await stat(filePath);
    if (!stats.isFile()) {
      return jsonError(404, "audio_not_found", hash);
    }
    size = stats.size;
  } catch {
    // Expected for a while: the TTS batch is still filling data/audio/.
    return jsonError(404, "audio_not_found", hash);
  }

  const etag = `"${hash}"`;
  const baseHeaders: Record<string, string> = {
    "Content-Type": "audio/mpeg",
    "Accept-Ranges": "bytes",
    "Cache-Control": IMMUTABLE,
    ETag: etag
  };

  if (request.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers: baseHeaders });
  }

  const range = parseRange(request.headers.get("range"), size);

  if (range === "unsatisfiable") {
    return new Response(null, {
      status: 416,
      headers: { ...baseHeaders, "Content-Range": `bytes */${size}` }
    });
  }

  if (range) {
    const length = range.end - range.start + 1;
    return new Response(withBody ? fileStream(filePath, range.start, range.end) : null, {
      status: 206,
      headers: {
        ...baseHeaders,
        "Content-Range": `bytes ${range.start}-${range.end}/${size}`,
        "Content-Length": String(length)
      }
    });
  }

  return new Response(withBody && size > 0 ? fileStream(filePath, 0, size - 1) : null, {
    status: 200,
    headers: { ...baseHeaders, "Content-Length": String(size) }
  });
}

export async function GET(request: Request, context: RouteContext) {
  return handle(request, context, true);
}

export async function HEAD(request: Request, context: RouteContext) {
  return handle(request, context, false);
}
