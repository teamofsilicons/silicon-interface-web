# Chat UX design QA

- Source visual truth:
  - `/Users/codanium/Downloads/Screenshot 2026-07-14 at 8.53.35 PM.png`
  - `/var/folders/cr/4xxx8tw93k50dllp_gz65rdm0000gn/T/TemporaryItems/NSIRD_screencaptureui_77CsHV/Screenshot 2026-07-14 at 5.11.04 PM.png`
- Authenticated implementation: `http://127.0.0.1:3000/chat?room=01KXDKNQWFVM04YQDZMD47CY76`
- User test surface: `http://127.0.0.1:3001/chat`
- Browser state: signed-in local QA Carbon, populated direct conversation, unread announcement, and waiting/delivered/read receipt fixtures.
- Primary implementation captures:
  - `artifacts/ux-qa/web-chat-source-aspect.jpg` — 1155 × 720 source-aspect desktop state
  - `artifacts/ux-qa/web-chat-badge-verified.jpg` — 1280 × 720 unread badge state
  - `artifacts/ux-qa/web-chat-final-verified.jpg` — 1280 × 720 delivered/read state
- Combined comparison evidence:
  - `artifacts/ux-qa/chat-reference-comparison.jpg`
  - `artifacts/ux-qa/header-reference-comparison.png`

## Evidence and findings

- Full conversation view: compared beside the supplied full-chat screenshot at the same desktop aspect ratio. Sidebar, room header, message surface, and composer retain the existing design language. No new layout, color, typography, or radius system was introduced.
- Notification alignment: the supplied bad-state crop was compared beside the implementation crop. The bell and profile controls are both 36 × 36. The unread badge is an 18 × 18 circle anchored to the bell corner rather than a large square overlapping both controls.
- One live visual defect was found during QA: before the final patch, the unread badge could compute to 9 px wide while development styles were warming. An explicit 18 px minimum width was added, then the browser capture and production gates were repeated.
- Connection scope: browser DOM evidence showed `Connecting…` only inside the selected chat. The application-wide offline state rendered a 1155 × 28 topmost alert at `(0, 0)` with `You’re offline` and `Retry`; the banner had a dark foreground background and light text. The global banner never used `Connecting…`.
- Activity receipts: the authenticated rendered DOM exposed `waiting`, `delivered`, and `read` accessible states. The implementation shows a clock, one tick, and two ticks respectively. Partial delivery remains waiting and partial read remains one tick, so the client never overclaims recipient activity.
- Threads: no thread action, panel, counter, or query-state control is rendered. The only remaining `thread` strings in the web source are backward-compatible wire receipt parsing. Some local QA message bodies intentionally contain the word “thread”; they are fixture content, not product UI.
- Plain language: visible recovery and loading copy uses `Connecting…`, `Refreshing your chats…`, `waiting`, `needs attention`, and short connection messages. Internal outbox, queue, cache, and sync terms remain implementation-only.

## Interaction and console checks

- Opened the notification bell, verified the announcement panel and unread transition, then closed it successfully.
- Verified notification and profile controls remain aligned in the open and closed states.
- Verified the selected chat renders cached history while its own status says `Connecting…`.
- Verified rendered receipt labels for waiting, delivered, and read.
- Checked the browser console after the final implementation pass: zero errors and zero warnings.
- Static user-facing copy audit found no exposed thread action and no exposed queue/outbox terminology.

## Comparison history

1. Source screenshots inspected; initial implementation QA was blocked because no browser tab was exposed.
2. Authenticated local browser session established. Full chat and focused header comparisons created.
3. Found the 9 px unread-badge collapse, fixed it, and recaptured the aligned 18 px badge.
4. Added delivered/read fixture evidence, repeated interaction checks, and confirmed a clean console.
5. Re-ran reliability, TypeScript, ESLint, production build, and diff checks after the visual fix; all passed.

## Required fidelity surfaces

- Fonts and typography: passed.
- Spacing and layout rhythm: passed.
- Colors and visual tokens: passed.
- Icon fidelity and alignment: passed.
- Copy, truncation, and status semantics: passed.
- Primary header interaction and browser console: passed.

final result: passed

---

# Payment Banner Design QA

- Source visual truth: `/var/folders/cr/4xxx8tw93k50dllp_gz65rdm0000gn/T/TemporaryItems/NSIRD_screencaptureui_JEnBzU/Screenshot 2026-07-18 at 12.23.52 AM.png`
- Focused source crop: `/Users/codanium/Documents/silicon/silicon-interface/design-qa-assets/payment-banner-before.png`
- Implementation screenshot: `/Users/codanium/Documents/silicon/silicon-interface/design-qa-assets/payment-banner-after.png`
- Combined comparison: `/Users/codanium/Documents/silicon/silicon-interface/design-qa-assets/payment-banner-comparison.png`
- Viewport: focused 320 × 115 CSS-pixel payment banner, normalized beside the reference crop
- State: informational payment reminder, one team, `$110.00`, 13 days remaining

## Full-view comparison evidence

The combined comparison confirms the requested structural change: the payment amount and CTA now occupy the same horizontal row, with the CTA aligned to the amount's right. The surrounding title, timing copy, banner color, hierarchy, and spacing remain consistent with the existing design.

## Focused region comparison evidence

The banner itself is the focused region. No additional crop was needed because the amount/CTA row, typography, color, and vertical rhythm are all readable in the 320 × 115 capture.

## Required fidelity surfaces

- Fonts and typography: Existing TikTok Sans hierarchy, weights, sizes, line heights, and tabular amount styling are unchanged. The longer CTA remains on one line.
- Spacing and layout rhythm: The CTA is on the amount row with a 12px gap and automatic right alignment. Banner padding and title/timing spacing are unchanged.
- Colors and visual tokens: Existing `bg-secondary`, foreground, muted foreground, and primary button tokens are unchanged.
- Image quality and asset fidelity: The production `IdAvatar` component and logo resolution logic are unchanged. The isolated browser harness held its neutral pre-hydration avatar placeholder, so the comparison intentionally evaluates only the edited content region.
- Copy and content: `Pay Now` is replaced by `Continue Payment`; all other app-specific copy is unchanged.

## Findings

No actionable P0, P1, or P2 visual mismatches were found for the requested change.

## Interaction and console checks

- The rendered banner exposes one enabled button named `Continue Payment`.
- The button keeps the existing `router.push` billing destination handler; no navigation code was changed.
- The isolated visual route did not reproduce the authenticated application shell, so end-to-end billing navigation was not used as a visual acceptance signal.
- Browser console was checked and showed no errors or warnings attributable to the payment banner.

## Comparison history

- Initial comparison: The reference placed `Pay Now` beside the upper copy while the requested design calls for the CTA beside the amount.
- Fix applied: Moved the existing button into the amount row, right-aligned it, changed the label to `Continue Payment`, and right-aligned the optional multi-team controls below that row.
- Post-fix evidence: `payment-banner-comparison.png` shows the amount and CTA aligned on the same row with no clipping or wrapping.

## Implementation checklist

- [x] CTA moved to the amount row.
- [x] CTA label changed to `Continue Payment`.
- [x] Existing billing destination preserved.
- [x] Multi-team controls preserved beneath the amount row.
- [x] Lint and TypeScript checks passed after removing the temporary visual harness.

## Follow-up polish

No P3 follow-up is required for this scoped change.

final result: passed
