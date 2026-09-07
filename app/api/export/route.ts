import "server-only";
import { exportProgress } from "@/lib/db";

export async function GET(): Promise<Response> {
  const payload = exportProgress();
  return new Response(JSON.stringify({ exportedAt: new Date().toISOString(), ...payload }, null, 2), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": 'attachment; filename="volka-progress.json"',
      "Cache-Control": "no-store",
    },
  });
}
