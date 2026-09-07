import { TopNav } from "@/components/top-nav";
import { loadSenseData } from "@/lib/data";
import { AbilityClient } from "./ability-client";

export default async function AbilityPage() {
  const data = await loadSenseData();
  return (
    <>
      <TopNav />
      <AbilityClient senses={data.senses} />
    </>
  );
}
