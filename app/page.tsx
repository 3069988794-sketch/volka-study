import { SessionShell } from "@/components/session-shell";
import { TopNav } from "@/components/top-nav";
import { loadSenseData } from "@/lib/data";
import { getSenseAudioMap } from "@/lib/audio-index";

export default async function TodayPage() {
  const data = await loadSenseData();
  const senseIds = data.senses.map((s) => s.sense_id);
  const audioMap = await getSenseAudioMap(senseIds);

  return (
    <>
      <TopNav />
      <SessionShell
        senses={data.senses}
        notice={data.notice}
        totalCount={data.counts.total}
        completeCn={data.counts.completeCn}
        audioMap={audioMap}
      />
    </>
  );
}
