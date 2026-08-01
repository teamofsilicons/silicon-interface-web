import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [callSource, workerSource, statusSource, taskSource, demoSource, roomViewSource] =
  await Promise.all([
    readFile(new URL("../../src/components/chat/work-call-card.tsx", import.meta.url), "utf8"),
    readFile(new URL("../../src/components/chat/work-worker-group-card.tsx", import.meta.url), "utf8"),
    readFile(new URL("../../src/components/chat/work-status-card.tsx", import.meta.url), "utf8"),
    readFile(new URL("../../src/components/chat/work-task-card.tsx", import.meta.url), "utf8"),
    readFile(new URL("../../src/components/chat/work-update-demo.tsx", import.meta.url), "utf8"),
    readFile(new URL("../../src/components/chat/room-view.tsx", import.meta.url), "utf8"),
  ]);

test("calls use the sketched inline row and keep the full-row transcript trigger", () => {
  assert.match(callSource, /className=\{cn\("w-full max-w-\[34rem\]"/);
  assert.match(callSource, /<DialogTrigger asChild>[\s\S]*?<button/);
  assert.match(
    callSource,
    /<span className="flex min-w-0 max-w-full items-center gap-1\.5">[\s\S]*?\{title\}[\s\S]*?<CaretRight/,
  );
  assert.doesNotMatch(callSource, /<span className="min-w-0 flex-1">/);
  assert.match(callSource, /Received call from \$\{call\.peer\}/);
  assert.match(callSource, /Calling \$\{call\.peer\}/);
  assert.match(callSource, /Called \$\{call\.peer\}/);
  assert.doesNotMatch(callSource, /contentPreview|workCallPreviewContent/);
  assert.match(callSource, /<DialogContent[\s\S]*?visibleSummary/);
  assert.match(callSource, /<DialogContent[\s\S]*?call\.transcript\.map/);
  assert.match(callSource, /const \[historyExpanded, setHistoryExpanded\] = React\.useState\(false\)/);
  assert.match(callSource, /aria-expanded=\{historyExpanded\}/);
  assert.match(callSource, /historyExpanded \? \([\s\S]*?<WorkHistory entries=\{call\.history\}/);
  assert.match(callSource, /summary\.localeCompare\(title/);
  assert.doesNotMatch(callSource, /message count|messages? received/i);
});

test("worker updates use one compact heading and a retained branched list", () => {
  assert.match(workerSource, /Started \{group\.workers\.length\}/);
  assert.match(workerSource, /className="ml-2\.5 border-l border-border\/90 pl-3\.5"/);
  assert.doesNotMatch(workerSource, /worker\.task/);
  assert.doesNotMatch(workerSource, /aria-live="polite"/);
  assert.match(workerSource, /description=\{worker\.description\}/);
  assert.match(workerSource, /currentActivity=\{worker\.currentActivity\}/);
  assert.match(
    workerSource,
    /triggerLabel=\{`Open activity for worker \$\{worker\.name\}`\}[\s\S]*?absolute inset-0/,
  );
  assert.doesNotMatch(workerSource, /DONE|WorkTimerFooter|WorkCardHeader/);
});

test("task, update, blocker, and completion preserve the sketched card anatomy", () => {
  assert.match(taskSource, /max-w-\[34rem\]/);
  assert.match(taskSource, /showStateIcon=\{false\}/);
  assert.match(statusSource, /event\.kind === "milestone"[\s\S]*?>\s*UPDATE\s*</);
  assert.match(statusSource, /inline-flex h-6[\s\S]*?border-b-0/);
  assert.match(statusSource, /event\.kind === "completion"[\s\S]*?<CheckCircle/);
  assert.match(statusSource, /<WorkConfettiButton \/>/);
  assert.match(statusSource, /triggerCoversHeader/);
});

test("all incoming durable update kinds receive the sender Silicon avatar", () => {
  assert.match(
    roomViewSource,
    /showWorkUpdateAvatar =[\s\S]*?workRecord !== null &&[\s\S]*?!workEventIsMine &&[\s\S]*?e\.sender_kind === "silicon"/,
  );
  assert.match(
    demoSource,
    /className=\{cn\([\s\S]*?"my-3 flex w-full items-start justify-start gap-2"[\s\S]*?<IdAvatar[\s\S]*?<WorkEventCard/,
  );
});

test("manager activity is woven before durable work that starts during the run", () => {
  assert.match(
    roomViewSource,
    /pushManagersThrough\(e\.created_at\);[\s\S]*?if \(isSystem\(e\)\)/,
  );
  assert.match(
    roomViewSource,
    /group\.history\[0\]\?\.occurred_at \?\? group\.updated_at/,
  );
});
