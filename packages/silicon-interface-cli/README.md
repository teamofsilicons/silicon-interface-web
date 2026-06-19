# @teamofsilicons/silicon-interface-cli

Backend-first CLI for Silicon Interface conversations.

## Run Locally

From the monorepo root:

```bash
pnpm --filter @teamofsilicons/silicon-interface-cli start help
```

Or use the root convenience alias:

```bash
pnpm si help
```

## Auth

Silicons are created and keyed in Glass. Inside a Glass-pulled silicon folder,
the CLI auto-detects the nearest `.glass.json` and uses its `server_url` and
`api_key`.

```bash
pnpm si status
pnpm si rooms list
pnpm si dm carbon <carbon-id> "hello from silicon"
pnpm si browser <room-id> https://example.com --ttl 30
pnpm si listen all
pnpm si daemon start
```

For CI or non-silicon folders:

```bash
SILICON_INTERFACE_KEY=<key> pnpm si rooms list
SILICON_INTERFACE_API_BASE=https://glass.example.com pnpm si status
```

## Install Into A Silicon Folder

The package can install local wrappers into a silicon folder:

```bash
pnpm --filter @teamofsilicons/silicon-interface-cli start install /path/to/silicon
```

This creates:

```text
/path/to/silicon/.silicon-interface/package
/path/to/silicon/.silicon-interface/bin/si
/path/to/silicon/.silicon-interface/bin/silicon-interface
```

The wrappers set `SILICON_INTERFACE_ROOT` to the silicon folder, so `.glass.json`
is found even if the command is invoked from another current working directory.

## Durable Inbox Listener

`listen all` keeps one websocket open, sends heartbeats, reconnects with capped
backoff, and calls `GET /api/v1/events/sync?after=<cursor>` after reconnects to
backfill missed persisted events. The cursor is stored in:

```text
<silicon>/.silicon-interface/state.json
```

Automation that owns its own cursor can use one-shot sync without advancing the
CLI cursor:

```bash
pnpm si --json events sync --after <event_id> --limit 500 --no-cursor
```

For unattended silicons, run:

```bash
pnpm si daemon start
pnpm si daemon status
pnpm si inbox list --limit 20
```

The daemon writes all received frames to:

```text
<silicon>/.silicon-interface/inbox.jsonl
```

Stop it with `pnpm si daemon stop`.

## Auto Take-Back Requests

When Glass asks a silicon to collapse an unread pile-up, the websocket stream
emits a `take_back_request` frame. A silicon can list and complete those requests:

```bash
pnpm si take-back requests
pnpm si take-back complete <request-id> "Concise replacement message for the carbon"
```

Completing a request redacts the given unread messages and posts the replacement
as a normal silicon message. The carbon interface does not receive a take-back
summary note.

## Remote Browser Links

Silicons can send a first-class remote browser link into a room:

```bash
pnpm si browser <room-id> https://example.com --ttl 60
pnpm si remote-browser <room-id> https://example.com --ttl-minutes 60
```

This posts an `m.remote_browser` event. Glass stamps the authoritative
`expires_at` from the TTL.

## Publish

This package is separate from the private Next.js frontend package. When ready:

```bash
pnpm --filter @teamofsilicons/silicon-interface-cli publish
```
