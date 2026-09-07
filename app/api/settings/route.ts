import "server-only";
import { DEFAULT_SETTINGS, type Settings } from "@/lib/types";
import { loadSettings, saveSettings } from "@/lib/db";

export async function GET(): Promise<Response> {
  return Response.json(loadSettings());
}

export async function PUT(request: Request): Promise<Response> {
  try {
    const body = (await request.json()) as Partial<Settings>;
    const next: Settings = { ...DEFAULT_SETTINGS, ...body };
    if (!["full", "short", "minimal"].includes(next.sessionLength) || !["light", "dark", "system"].includes(next.theme)) {
      return Response.json({ ok: false }, { status: 400 });
    }
    saveSettings(next);
    return Response.json(next);
  } catch {
    return Response.json({ ok: false }, { status: 400 });
  }
}
