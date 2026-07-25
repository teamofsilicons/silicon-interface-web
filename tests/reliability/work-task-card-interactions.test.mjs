import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [taskCardSource, sharedSource] = await Promise.all([
  readFile(new URL("../../src/components/chat/work-task-card.tsx", import.meta.url), "utf8"),
  readFile(new URL("../../src/components/chat/work-update-shared.tsx", import.meta.url), "utf8"),
]);

test("the root todo header exposes one full-surface dialog trigger", () => {
  assert.match(taskCardSource, /<WorkCardHeader[\s\S]*?triggerCoversHeader/);
  assert.match(sharedSource, /triggerCoversHeader && "relative pr-12"/);
  assert.match(
    sharedSource,
    /triggerCoversHeader[\s\S]*?"absolute inset-0 z-10 h-full w-full justify-end/,
  );
});

test("each todo remains a semantic list item with a full-row dialog trigger", () => {
  assert.match(taskCardSource, /<ul aria-label=\{`\$\{task\.title\} todo`\}>/);
  assert.match(taskCardSource, /<li[\s\S]*?"relative flex min-w-0 items-center/);
  assert.match(
    taskCardSource,
    /triggerLabel=\{`Open details for todo item \$\{item\.title\}`\}[\s\S]*?triggerClassName="absolute inset-0 z-10 h-full w-full justify-end/,
  );
});

test("full-surface triggers are native buttons with a visible keyboard focus ring", () => {
  assert.match(sharedSource, /<DialogTrigger asChild>[\s\S]*?<button[\s\S]*?type="button"/);
  assert.match(sharedSource, /focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/);
  assert.doesNotMatch(taskCardSource, /<(?:li|div)[^>]+role="button"/);
});
