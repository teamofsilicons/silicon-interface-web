# Silicon Interface CLI 2.0

The Glass-native command-line interface for Silicon Interface. Glass is the
source of truth: the CLI uses its current protocol headers, signed cursors,
event and account sync streams, WebSocket barriers, idempotency keys, and
multipart media contracts rather than maintaining a second chat protocol.

Requires Node.js 22 or newer.

With no endpoint override, the CLI connects to the production Glass service at
`https://glass.teamofsilicons.com` and derives
`wss://glass.teamofsilicons.com` for realtime delivery. `--api`, `--ws`, the
corresponding environment variables, saved config, and `.glass.json` override
those defaults, so local Glass development can still use `http://127.0.0.1:8000`.

## Start

From the monorepo root:

```bash
pnpm si help
pnpm si status
```

Inside a Glass-pulled silicon directory, the nearest `.glass.json` supplies the
server, WebSocket URL, and Silicon key automatically. You can also configure
the CLI explicitly:

```bash
si auth import-glass /path/to/silicon
si auth set-key
si auth login <phone-email-or-username>
si auth register --email person@example.com --phone +15551234567 --username person
si auth available person
si config show
```

Successful `install` (when `.glass.json` already contains a key), `auth
import-glass`, `auth set-key`, `auth set-token`, Carbon registration, and Carbon
login start the durable live-inbox daemon automatically. Credential changes
restart it so the process never keeps using an old identity; `auth clear` stops
it. Pass `--no-daemon` on a setup/auth command only when background delivery is
intentionally unwanted.

Carbon login registers a durable CLI device by default and stores the resulting
device-bound tokens. Pass `--no-device` only for a deliberately legacy session.
Credentials and refresh tokens are redacted by `config show`.

## Messages and complete history

```bash
si rooms list
si messages recent <room-id> --limit 50
si history <room-id>
si history <room-id> --output history.json
si history <room-id> --output history.jsonl
si search "deployment plan" --room <room-id> --all

si send <room-id> "hello"
si send <room-id> "reply" --reply-to <event-id>
si send <room-id> "quick note; still working" --work-continues --group <run-id>
si send <room-id> "finished" --group <run-id>
si send-event <room-id> --data '{"type":"m.text","content":{"body":"hello"}}'
si messages edit <event-id> "corrected text" --base-version 1
si messages react <event-id> "👍"
si messages thread <event-id> --all
si messages forward <target-room> <source-room> <event-id...>
```

History uses Glass's opaque, principal-bound, fixed-boundary cursors. `history`
walks every page in chronological order and can recover from an expired cursor
using an anchored continuation without silently skipping older messages.

Every normal send receives a durable `client_id`. If a request or process dies
after Glass commits but before the response arrives, rerunning the same command
reuses the pending operation identity instead of creating a duplicate message.
The local operation journal lives under `.silicon-interface/operations.json`.
Ambiguous operations can be inspected and reconciled against Glass without
replaying their message bodies:

```bash
si operations list
si operations resolve all
```

## Durable work tasks and updates

Work cards use a first-class, persisted Glass contract. A task owns its todo
items and append-only history; milestone, blocker, worker, call, and terminal
updates remain attached to the same stable `task_id`. Multiple tasks may be
active in one room.

Short manager activity remains on the existing progress channel. Stable frame
and group identities let Interface build an expandable, replay-safe history;
`done` leaves that history visible until a linked normal message replaces it.
Every `progress` command requires `--group`; generate one run id when work starts
and reuse it for every minor-status frame through `done`. Put the same id on
normal messages with `send --group`. A normal message intentionally interleaved
while work continues uses `--work-continues`; omit it on the final replacing
message. This writes `content.progress_group_id` and `content.work_continues`
without changing reply or `--final` behavior. Streamed events do not replace
activity until their `event.final` commit.

```bash
si progress room_123 reading "Pulling the docs" \
  --group run_123 --task task_123 --frame activity_1 --revision 1 \
  --at 2026-07-23T08:20:00Z
si progress room_123 spawning_worker "Starting the UI worker" \
  --group run_123 --task task_123 --frame activity_2 --revision 1
si send room_123 "The UI is ready; tests are still running" \
  --group run_123 --work-continues
si progress room_123 done --group run_123 --task task_123 --frame activity_3
si send room_123 "Everything is complete" --group run_123
```

Every mutation accepts a JSON object via `--data`, `--data-file`, or `--data -`
(stdin). Nested rich content is forwarded unchanged, including text, images,
files, voice, remote-browser references, transcripts, and ordered block arrays.
For every work POST, the CLI adds a durable `client_id` when one is absent and
journals it locally. If a process or response fails after Glass commits, rerun
the exact command to reuse the pending id instead of duplicating a task or card.
Use `--client-id <id>` (or a payload `client_id`) when the caller already owns a
stable id. Use `--json` independently when the response must be machine-readable.

For estimate input, prefer `realistic_estimate_seconds`. Put it at the payload
root for a task and inside `timing` for a child event. The CLI sends only the
canonical `estimate_seconds`, calculated as
`ceil(realistic_estimate_seconds * 1.05)`; the helper field never reaches Glass.
A direct `estimate_seconds` remains supported when it already includes the 5%
buffer. If both fields are supplied in one location they must agree exactly,
and a payload containing `timing` must place estimate fields inside it rather
than at the root. Negative, non-numeric, conflicting, and unsafe values fail
locally before any request.

```bash
si --json work task create --data '{
  "schema_version": 1,
  "room_id": "room_123",
  "title": "Build Fitness App",
  "description": "Build and verify the first release",
  "state": "running",
  "realistic_estimate_seconds": 21600
}'
si --json work task list room_123 --state running
si --json work task show task_123
si --json work task patch task_123 --data '{"description":"UI complete; implementing data flow","revision":4}'

si --json work todo add task_123 --data '{"todo_id":"todo_ui","title":"UI/UX","state":"yet_to_start","description":"Design the main flow"}'
si --json work todo patch task_123 todo_ui --data '{"state":"completed","description":"UI/UX completed","revision":2}'
si --json work milestone update task_123 --data-file milestone.json
si --json work milestone update task_123 --data '{"kind":"milestone","body":"UI complete","timing":{"realistic_estimate_seconds":3600,"active_elapsed_seconds":1200,"timer_state":"running","timer_updated_at":"2026-07-23T08:20:00Z"}}'

si --json work blocker create task_123 --data '{"work_event_id":"event_blocker_color","kind":"blocker","blocker_id":"blocker_color","state":"open","resolved_at":null,"body":"Should the primary color be red or blue?","blocks":[{"type":"text","body":"Should the primary color be red or blue?","format":"plain"}]}'
si --json work blocker resolve task_123 blocker_color --data '{"state":"resolved","body":"Use blue","blocks":[{"type":"file","media_id":"brand_guide","filename":"brand.pdf"}]}'

si --json work worker-group create task_123 --data '{"work_event_id":"event_workers","kind":"worker_group","group_id":"group_social","body":"Started 3 workers","blocks":[],"workers":[]}'
si --json work worker create task_123 group_social --data '{"worker_id":"worker_linkedin","invocation_id":"invoke_1","name":"LinkedIn post","description":"Drafting","state":"in_progress","revision":1,"history":[]}'
si --json work worker patch task_123 group_social invoke_1 --data '{"state":"completed","description":"Draft delivered"}'

si --json work call create task_123 --data '{"work_event_id":"event_call_1","kind":"call","call_id":"call_1","direction":"outbound","target_kind":"manager","target_id":"saket","target_name":"Saket manager","state":"connecting","body":"Calling Saket manager","blocks":[],"transcript":[]}'
si --json work call patch task_123 call_1 --data '{"state":"completed","transcript":[{"transcript_id":"transcript_1","speaker_kind":"silicon","speaker_id":"saket_manager","speaker_name":"Saket manager","body":"Approved","blocks":[],"revision":1}]}'

si --json work complete task_123 --data '{"work_event_id":"event_complete","kind":"completion","body":"Fitness app delivered and verified","blocks":[]}'
si --json work fail task_123 --data '{"work_event_id":"event_failure","kind":"failure","body":"Build could not recover","blocks":[{"type":"file","media_id":"media_1","filename":"build.log"}]}'
si --json work cancel task_123 --data '{"work_event_id":"event_cancel","kind":"cancellation","body":"Cancelled by the requester","blocks":[]}'
```

Canonical task states are `queued`, `running`, `blocked`, `completed`,
`failed`, and `cancelled`; todo states are `yet_to_start`, `in_progress`,
`completed`, and `blocked`; worker invocations additionally support `failed`
and `cancelled`. Timer state is `running`, `paused`, or `stopped`. Patch bodies
may carry the server-provided `revision` for
optimistic concurrency. Calls distinguish `inbound`/`outbound` direction and
`manager`/`silicon` targets in their JSON rather than flattening conversations
into status text.

`estimate_seconds` is the producer's realistic active wall-clock estimate after
accounting for parallel workers, with a 5% safety margin already added. Queued
work and waits on another Silicon continue the timer. Pause it only for an open
blocker, rate limit, offline state, or infrastructure failure, using the matching
`timer_pause_reason`; open blockers must be `paused` with reason `blocker`, and
completion/failure/cancellation snapshots must be `stopped`.

The dedicated commands map to this REST contract:

```text
GET    /api/v1/work/tasks
POST   /api/v1/work/tasks
GET    /api/v1/work/tasks/{task_id}
PATCH  /api/v1/work/tasks/{task_id}
POST   /api/v1/work/tasks/{task_id}/todos
PATCH  /api/v1/work/tasks/{task_id}/todos/{todo_id}
POST   /api/v1/work/tasks/{task_id}/milestones
POST   /api/v1/work/tasks/{task_id}/blockers
POST   /api/v1/work/tasks/{task_id}/blockers/{blocker_id}/resolve
POST   /api/v1/work/tasks/{task_id}/worker-groups
PATCH  /api/v1/work/tasks/{task_id}/worker-groups/{group_id}
POST   /api/v1/work/tasks/{task_id}/worker-groups/{group_id}/invocations
PATCH  /api/v1/work/tasks/{task_id}/worker-groups/{group_id}/invocations/{invocation_id}
POST   /api/v1/work/tasks/{task_id}/calls
PATCH  /api/v1/work/tasks/{task_id}/calls/{call_id}
POST   /api/v1/work/tasks/{task_id}/complete
POST   /api/v1/work/tasks/{task_id}/fail
POST   /api/v1/work/tasks/{task_id}/cancel
```

## Attachments and albums

```bash
si send-file <room-id> ./report.pdf "latest report"
si send-files <room-id> ./one.png ./two.png --caption "screenshots"
si attachments list <room-id> --all --resolve
si attachments download <room-id> ./downloads --all
si media show <media-id>
si media download <media-id> ./file.bin
```

Uploads use Glass's resumable multipart sessions, per-part checksums, whole-file
SHA-256, and completion proof. A repeated command resumes the same upload.
Older Glass deployments automatically fall back to the legacy presigned upload
contract. Downloads refresh expired signed URLs and verify SHA-256 when Glass
provides one. Albums publish two to ten ready files as one atomic `m.album`
event, so recipients never see a partial group.

## Local speech tools

Standalone speech-to-text accepts a local audio file, uploads it privately to
Glass, waits for the authoritative transcript, and prints only the transcript
for easy shell composition. It also accepts an existing Glass media ID:

```bash
si stt ./voice-note.m4a
si stt ./interview.wav --language en --output interview.txt
si stt <media-id> --json
```

Standalone text-to-speech waits for Glass and downloads the generated MP3. Text
may come from arguments, a file, or stdin:

```bash
si tts "Deploy completed"
si tts "Welcome aboard" --voice Puck --output welcome.mp3
si tts --text-file narration.txt --output narration.mp3
printf '%s' "Build complete" | si tts --output build-complete.mp3
```

Without `--output`, standalone TTS saves `tts-<media-id>.mp3` in the current
directory and prints its absolute path. Add `--room <room-id>` to retain the
existing behavior where Glass posts an `m.tts` event when synthesis completes;
combine it with `--output` to post and keep a local copy. Both commands accept
`--wait-seconds` and `--poll-ms`, or `--no-wait` when only queueing is desired.

## Durable live stream and inbox

```bash
si listen all
si listen <room-id>
si daemon start
si daemon status
si inbox list --limit 50
si daemon stop
```

Normally no manual daemon command is needed because setup and authentication
start it automatically. `daemon start`, `stop`, and `restart` remain available
for operations and troubleshooting.

`listen` and the daemon:

- connect to WebSocket before syncing and hold live frames behind Glass's hello
  barrier;
- reconcile both the event-vector stream and the account-state stream;
- validate every range/vector proof before committing its signed cursor;
- deduplicate buffered and replayed frames, honor negotiated heartbeats, and
  reconnect with bounded jitter;
- rebuild from `/sync/initial` on an expired cursor or failed integrity proof;
- spool to `.silicon-interface/inbox.jsonl` by default and acknowledge delivery
  only after the event is stored.

Use `listen --no-spool` for an intentionally ephemeral foreground stream.
One-shot reconciliation is also available:

```bash
si messages sync --spool
si messages sync --reset --spool
```

Stream checkpoints are scoped by Glass server, identity/device, and listener
scope in `.silicon-interface/state.json`; a room-specific listener does not
consume another room's checkpoint.

## Drafts, delayed sends, and account state

```bash
si drafts list
si drafts put <room-id> "work in progress" --base-version 2
si held create <room-id> "send later" --hold-seconds 30
si held patch <room-id> <held-id> --base-version 1 --body "updated"
si held send-now <room-id> <held-id>
si preferences show
si preferences set --read-receipts false --presence contacts
si devices list
si presence active
```

Draft and held-send changes arrive through the same durable account stream used
by Silicon Interface, including optimistic-concurrency versions.

## Automation output

`--json` emits one JSON value. `--jsonl` is intended for event streams and
shell pipelines. Global flags may appear anywhere in the command:

```bash
si --json rooms list
si --json history <room-id>
si --jsonl listen all
si --api https://glass.example --key "$SILICON_KEY" rooms list
```

Network calls have bounded timeouts and retry only safe requests or requests
protected by a Glass idempotency key. The CLI sends `X-Chat-Protocol: 1`, a
stable device header when applicable, and a W3C trace context on every API
request. Carbon access tokens refresh automatically.

## Teams, safety, and the complete Glass API surface

Ergonomic commands cover chat, history, sync, media, drafts, delayed sends,
rooms, activity, reactions, threads, search, contacts, sessions, crons, TTS,
STT, Carbon registration and presence, teams and invites, billing, moderation,
take-back policy, announcements, costs, push subscriptions, abuse challenges,
and Silicon cloud-browser sessions:

```bash
si teams list
si teams invite-create acme --scope team --channel link --role member
si teams checkout acme --cycle-ids 12,13
si invites show <token>
si moderation report carbon <carbon-id> --event <event-id> --reason spam
si take-back-policy set --enabled true --unread-threshold 3
si browser-session open <silicon-id>
```

Checkout retries retain the same Glass idempotency key until the operation has
a definitive response. Reports likewise carry a durable client ID.

The authenticated raw command keeps the full current and future Glass surface
available without waiting for a CLI release:

```bash
si glass schema --output glass-openapi.json
si glass get /api/v1/teams/
si glass patch /api/v1/carbons/me --data '{"tagline":"building"}'
si glass get /api/v1/events/search --query q=hello --query limit=20
si glass post /api/v1/moderation/reports --data-file report.json --idempotent
si glass post /api/v1/teams/acme/logo --file file=./logo.png
si glass get /api/v1/media/<media-id>/content --response binary --output media.bin
```

`api` is an alias for `glass`. Use `--data -` to read JSON from stdin,
`--form`/`--file` for multipart requests, and `--raw-body -` for raw stdin.
JSON, text, and binary responses can be written without transcoding. Raw
requests use the same authentication, protocol negotiation, refresh, timeout,
error model, and retry rules as the dedicated commands.

## Install into a silicon

```bash
pnpm --filter @teamofsilicons/silicon-interface-cli start install /path/to/silicon
```

This installs self-contained `si` and `silicon-interface` wrappers under
`<silicon>/.silicon-interface/bin/`. The wrappers preserve the silicon root so
Glass configuration and durable state are found even when invoked elsewhere.

## Publish

```bash
pnpm --filter @teamofsilicons/silicon-interface-cli publish
```
