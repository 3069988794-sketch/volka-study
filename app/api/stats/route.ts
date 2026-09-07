import "server-only";
import { getGlobalStats } from "@/lib/db";

export async function GET(): Promise<Response> {
  return Response.json(getGlobalStats());
}
