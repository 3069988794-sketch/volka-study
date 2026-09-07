import { loadSenseData } from "@/lib/data";

export async function GET() {
  const data = await loadSenseData();
  return Response.json(data);
}
