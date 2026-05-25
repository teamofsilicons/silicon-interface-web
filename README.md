# silicon-chat-frontend

Next.js 15 (App Router) test client for the [silicon-chat backend](../silicon-chat-backend/). Real chat UI **plus** a `/dev` endpoint explorer. Light-mode-only, styled after [siliconfriendly.com](https://siliconfriendly.com/) — minimalist, monochrome with a teal accent.

## Quickstart

```bash
# 1. Backend must be running on http://127.0.0.1:8000
#    cd ../silicon-chat-backend && uv run python manage.py runserver

# 2. Install + boot the frontend
pnpm install
cp .env.example .env.local   # only if you want to override the defaults
pnpm dev
# → http://localhost:3000
```

## What's where

| Route | Purpose |
| --- | --- |
| `/` | Bounces you to `/auth/login` or `/chat` based on whether you have a session. |
| `/auth/register` | 3-step register: phone OTP → email OTP → username. Phone/email order doesn't matter. The **fetch dev code** button hits `/api/v1/dev/last-otp` so you can complete the flow without real SMS/email. |
| `/auth/login` | 2-step login: identifier (phone/email/username) → OTP. |
| `/chat` | Element-style chat surface. Room list on the left, timeline + composer on the right. Sends text / files / images / TTS voice notes. Live WS updates: new events, deltas, progress, read receipts, take-back. |
| `/dev` | Raw endpoint explorer. One card per endpoint, with inputs + run button + JSON response. Plus a live WS event log tab. |
| `/settings` | Profile, take-back policy editor, paste-a-silicon-key (so you can test the same UI as a silicon). |

## How OTPs work in dev

The backend's `[dev-sms]` and `[dev-email]` log lines print the code to the Django server logs — but you don't need to scrape them. The backend exposes `GET /api/v1/dev/last-otp?target=<phone-or-email>` (gated on `settings.DEBUG`) that brute-forces the most recent stored sha256 hash back to the 6-digit code. The **fetch dev code** button on auth pages calls this for you.

In production this endpoint 404s, so the brute-force trick stays a dev-only thing.

## Auth model

- Carbons authenticate with a JWT pair (access + refresh). Both are stored in `localStorage` under `silicon-chat:access` / `silicon-chat:refresh`.
- Silicons authenticate with an API key in `X-Silicon-Key`. The settings page lets you paste one to test the same UI as a silicon.
- The API client (`src/lib/api.ts`) automatically attaches whichever credential is present. If both are set, the silicon key wins (matches backend behavior — `SiliconKeyAuthentication` runs first).

## Styling

Light mode only. Tailwind v4 with `@theme` tokens in `src/app/globals.css`. shadcn-style UI primitives in `src/components/ui/`. Geist Sans for body, Geist Mono for code/data. Accent color is `#0891b2` (cyan-600 teal).

If you want dark mode later, add a `[data-theme="dark"]` block to `globals.css` and a theme toggle — the components already use the CSS variables.

## Project layout

```
src/
├── app/
│   ├── layout.tsx, page.tsx, globals.css
│   ├── auth/{layout, register, login}/page.tsx
│   ├── chat/{layout, page}.tsx
│   ├── dev/{layout, page}.tsx
│   └── settings/{layout, page}.tsx
├── components/
│   ├── ui/                  # shadcn-style primitives (button, input, dialog, …)
│   ├── chat/                # room-list, room-view, composer, message-bubble, …
│   └── dev/                 # endpoint-card, ws-log
└── lib/
    ├── api.ts               # typed fetch wrapper for every backend endpoint
    ├── auth.ts              # JWT + silicon-key store + useAuth hook
    ├── ws.ts                # useChatSocket hook
    ├── env.ts               # apiBase / wsBase
    ├── types.ts             # shared TS types matching the backend serializers
    └── utils.ts             # cn(), relativeTime(), shortId()
```

## Build / lint

```bash
pnpm dev                  # dev server
pnpm build                # production build
pnpm exec tsc --noEmit    # type check
pnpm lint
```
