import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { workCallPreviewContent } from "../../src/lib/work-call-presentation.ts";

const [callCardSource, taskCardSource, statusCardSource, demoSource] = await Promise.all([
  readFile(new URL("../../src/components/chat/work-call-card.tsx", import.meta.url), "utf8"),
  readFile(new URL("../../src/components/chat/work-task-card.tsx", import.meta.url), "utf8"),
  readFile(new URL("../../src/components/chat/work-status-card.tsx", import.meta.url), "utf8"),
  readFile(new URL("../../src/components/chat/work-update-demo.tsx", import.meta.url), "utf8"),
]);

test("collapsed calls show the latest conversation content without a count", () => {
  assert.equal(
    workCallPreviewContent({
      summary: "Call connected",
      transcript: [
        { body: "Can you review the interaction?" },
        { body: "Use restrained motion and preserve reduced-motion behavior." },
      ],
    }),
    "Use restrained motion and preserve reduced-motion behavior.",
  );
  assert.equal(
    workCallPreviewContent({ summary: "Waiting for the manager to join.", transcript: [] }),
    "Waiting for the manager to join.",
  );
  assert.equal(workCallPreviewContent({ summary: "  ", transcript: [{ body: " " }] }), null);

  assert.match(callCardSource, /\{contentPreview\}/);
  assert.doesNotMatch(callCardSource, /\bmessages?\b/i);
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

test("the fake run keeps URL autoplay without rendering stage chrome", () => {
  assert.match(demoSource, /initialAutoplay/);
  assert.doesNotMatch(demoSource, /scene\.stageIndex\s*\+\s*1/);
  assert.doesNotMatch(
    demoSource,
    /Previous demo stage|Next demo stage|Pause fake run|Play fake run|Choose demo stage/,
  );
});
