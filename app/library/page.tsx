import { TopNav } from "@/components/top-nav";
import { loadSenseData } from "@/lib/data";
import { LibraryClient } from "./library-client";
import { getSenseAudioMap } from "@/lib/audio-index";

export default async function LibraryPage() {
  const data = await loadSenseData();
  const audioMap = await getSenseAudioMap(data.senses.map((sense) => sense.sense_id));
  return (
    <>
      <TopNav />
      <LibraryClient senses={data.senses} audioMap={audioMap} />
    </>
  );
}
