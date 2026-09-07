import "server-only";
import { loadPersistedSenseStates } from "@/lib/db";

export async function GET(): Promise<Response> {
  return Response.json({ states: loadPersistedSenseStates() });
}
