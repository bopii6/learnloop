// 回放页：/replay/[id] —— 只读白板课回放（分享链接落地页）
import { ReplayPlayer } from "@/components/ReplayPlayer";

export default async function ReplayPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ReplayPlayer replayId={id} />;
}
