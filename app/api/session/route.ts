import "server-only";
import { deleteSession, loadSession, saveSession } from "@/lib/db";
import type { SessionRecord } from "@/lib/db";

function sessionId(request: Request): string {
  return new URL(request.url).searchParams.get("id") || "default";
}

export async function GET(request: Request): Promise<Response> {
  const session = loadSession(sessionId(request));
  return session ? Response.json(session) : Response.json({ session: null }, { status: 404 });
}

export async function PUT(request: Request): Promise<Response> {
  try {
    const body = (await request.json()) as Partial<SessionRecord>;
    if (typeof body.id !== "string" || !body.id || typeof body.startedAt !== "string" || !Array.isArray(body.segmentsDone)) {
      return Response.json({ ok: false }, { status: 400 });
    }
    saveSession(body as SessionRecord);
    return Response.json({ ok: true, session: loadSession(body.id) });
  } catch {
    return Response.json({ ok: false }, { status: 400 });
  }
}

export async function DELETE(request: Request): Promise<Response> {
  deleteSession(sessionId(request));
  return Response.json({ ok: true });
}
