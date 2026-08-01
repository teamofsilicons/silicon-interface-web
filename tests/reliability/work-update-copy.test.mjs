import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [callCardSource, taskCardSource, statusCardSource, demoSource, roomViewSource] = await Promise.all([
  readFile(new URL("../../src/components/chat/work-call-card.tsx", import.meta.url), "utf8"),
  readFile(new URL("../../src/components/chat/work-task-card.tsx", import.meta.url), "utf8"),
  readFile(new URL("../../src/components/chat/work-status-card.tsx", import.meta.url), "utf8"),
  readFile(new URL("../../src/components/chat/work-update-demo.tsx", import.meta.url), "utf8"),
  readFile(new URL("../../src/components/chat/room-view.tsx", import.meta.url), "utf8"),
]);

test("every collapsed call stays heading-only while details retain conversation content", () => {
  assert.doesNotMatch(callCardSource, /contentPreview|workCallPreviewContent/);
  assert.match(callCardSource, /<DialogContent[\s\S]*?visibleSummary/);
  assert.match(callCardSource, /<DialogContent[\s\S]*?call\.content/);
  assert.match(callCardSource, /<DialogContent[\s\S]*?call\.transcript\.map/);
  assert.match(callCardSource, /<DialogContent[\s\S]*?call\.history/);
  assert.doesNotMatch(callCardSource, /\bmessages?\b/i);
});

test("calls render as lightweight timeline rows without a task-heading card", () => {
  assert.match(callCardSource, /className=\{cn\("w-full max-w-\[34rem\]"/);
  assert.match(callCardSource, /Open call transcript/);
  assert.doesNotMatch(callCardSource, /\{call\.taskTitle \? \(/);
  assert.doesNotMatch(callCardSource, /DONE|message count/i);
});

test("every Silicon-authored work update keeps the Silicon identity", () => {
  assert.match(
    roomViewSource,
    /showWorkUpdateAvatar =[\s\S]*?workRecord !== null &&[\s\S]*?!workEventIsMine &&[\s\S]*?e\.sender_kind === "silicon"/,
  );
  assert.match(
    demoSource,
    /<IdAvatar[\s\S]*?seed="fitness-builder"[\s\S]*?<WorkEventCard/,
  );
});

test("work cards call task items todos in visible and accessible copy", () => {
  const workCardCopy = `${taskCardSource}\n${statusCardSource}`;
  assert.match(taskCardSource, />\s*TODO · \{complete\}\/\{task\.items\.length\}\s*</);
  assert.match(taskCardSource, /Open details for todo item/);
  assert.match(taskCardSource, /todo items completed/);
  assert.match(taskCardSource, /No todo items yet\./);
  assert.match(statusCardSource, />\s*TASK TODO\s*</);
  assert.doesNotMatch(workCardCopy, /["'`][^"'`\n]*checklist/i);
});

test("the local showcase keeps URL autoplay without rendering stage chrome", () => {
  assert.match(demoSource, /initialAutoplay/);
  assert.doesNotMatch(demoSource, /scene\.stageIndex\s*\+\s*1/);
  assert.doesNotMatch(demoSource, /FAKE RUN/);
  assert.doesNotMatch(
    demoSource,
    /Previous demo stage|Next demo stage|Pause fake run|Play fake run|Choose demo stage/,
  );
});
