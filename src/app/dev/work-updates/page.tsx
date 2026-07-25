import { notFound } from "next/navigation";

import { WorkUpdateDemo } from "@/components/chat/work-update-demo";
import { workUpdateDemoAvailable } from "@/lib/work-update-demo-access";
import { fitnessDemoStage } from "@/lib/work-update-demo-fixtures";

export default async function WorkUpdatesDemoPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (!workUpdateDemoAvailable(process.env.NODE_ENV)) notFound();

  const query = await searchParams;
  const rawStage = Array.isArray(query.stage) ? query.stage[0] : query.stage;
  const rawAutoplay = Array.isArray(query.autoplay)
    ? query.autoplay[0]
    : query.autoplay;

  return (
    <WorkUpdateDemo
      initialStage={fitnessDemoStage(rawStage)}
      initialAutoplay={rawAutoplay === "1" || rawAutoplay === "true"}
      initialNowIso={new Date().toISOString()}
    />
  );
}
