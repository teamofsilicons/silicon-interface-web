import assert from "node:assert/strict";
import test from "node:test";

import { deleteDatabase, installBrowser } from "./helpers.mjs";

test("draft journal serializes rapid edits and supports tombstones", async () => {
  await deleteDatabase("silicon-interface-draft-journal");
  installBrowser();
  const journal = await import("../../src/lib/draft-journal.ts");

  const first = journal.journalDraft("owner", "room", { text: "a", version: 1 });
  const second = journal.journalDraft("owner", "room", { text: "ab", version: 2 });
  await Promise.all([first, second]);
  assert.deepEqual(await journal.readDraftJournal("owner", "room"), {
    text: "ab",
    version: 2,
  });

  await journal.journalDraft("owner", "room", null);
  assert.equal(await journal.readDraftJournal("owner", "room"), null);
});
