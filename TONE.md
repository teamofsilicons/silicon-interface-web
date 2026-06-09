# Tone & voice — silicon-interface

You're not writing for a chat app. you're writing for a friendly terminal where
carbons and silicons meet. every string should feel *compiled, not designed* —
precise, monospace at heart, a little playful, never shouty.

This is a practical checklist. when in doubt, read a line aloud: if it sounds
like a marketer or an error dialog from 2009, rewrite it.

---

## The rules

1. **lowercase.** ui copy, buttons, labels, empty states, toasts — all lowercase.
   proper nouns and a person's display name keep their own casing. acronyms stay
   uppercase (`QR`, `OTP`, `WS`, `ID`).

2. **no exclamation marks.** ever. enthusiasm comes from precision and rhythm,
   not punctuation. `link copied` — not `link copied!`.

3. **system lines are prefixed with `>`.** anything the machine is narrating
   about itself — boot, status, empty states, confirmations of an automated
   action — leads with `> `. examples: `> inbox is quiet.`, `> linking carbons +
   silicons…`, `> first contact established`, `> balance cleared`.

4. **mono for machine values.** ids, codes, links, counts, timers, ascii marks,
   and anything you'd paste into a terminal render in JetBrains Mono. prose can
   be the body face; data is mono.

5. **errors are warm and human, not raw.** never dump a stack trace or a generic
   "something went wrong" at someone. say what happened and what they can do.
   - surface technical failures as `stderr: <message>` in mono when it's a
     genuine system error.
   - for friction (rate limits, expired codes, network blips), keep the breather
     voice — calm, lowercase, a little kind. anchor: `take a breather ☕`.
   - never claim success you can't verify (e.g. only toast "copied" on a real
     copy).

6. **terminal soul, sparingly.** a `>` prefix, an ascii beat, a `·` separator,
   an ellipsis on an in-progress action (`reading…`, `searching…`). don't
   over-garnish — one terminal gesture per line is plenty.

7. **carbon vs silicon awareness.** when it reads naturally, distinguish the two:
   `silicon is thinking…` vs `alice is typing…`. it reinforces who's who without
   a label.

---

## Punctuation & symbols

- separators: ` · ` (middle dot) between peers of equal weight.
- in-progress: trailing `…` (a real ellipsis, not three dots).
- emoji: rare and intentional. the `☕` breather is the sanctioned one. no
  decorative emoji in system lines.
- no title case. no ALL CAPS for emphasis (mono uppercase labels via `.label-mono`
  are fine — that's typographic, not shouting).

---

## Quick examples

| instead of | write |
| --- | --- |
| `No notifications yet.` | `> inbox is quiet.` |
| `Loading…` (auth) | `> linking carbons + silicons…` |
| `Success! Link copied!` | `link copied` |
| `Error: request failed` | `stderr: request failed` |
| `Too many attempts!!` | `too many tries — take a breather ☕` |
| `404 Not Found` | `> 404 · route not found` |
| `Copy Link` (button) | `copy link` |
| `Page Not Found` | `> 404 · route not found` |

---

## The smell test

before shipping a string, ask:
- is it lowercase (minus names/acronyms)?
- did i remove every `!`?
- if a machine is narrating, does it start with `>`?
- are codes/ids/links in mono?
- if it's an error, is it honest *and* kind?

if all five pass, it's on-brand.
