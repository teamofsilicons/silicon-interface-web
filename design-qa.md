# Design QA

**Comparison target**

- Source visual truth: `/var/folders/cr/4xxx8tw93k50dllp_gz65rdm0000gn/T/TemporaryItems/NSIRD_screencaptureui_Y5lG74/Screenshot 2026-07-27 at 2.35.33 AM.png`, interpreted with the user's clarification that the manager activity belongs to the same message group but must not sit inside the message bubble.
- Browser-rendered implementation: `/Users/codanium/Documents/silicon/silicon-interface/artifacts/work-update-completed-final.png`
- Focused implementation region: `/Users/codanium/Documents/silicon/silicon-interface/artifacts/manager-message-group-focused.png`
- Combined comparison input: `/Users/codanium/Documents/silicon/silicon-interface/artifacts/manager-message-group-comparison.png`
- Route/state: `/dev/work-updates?stage=completed&preview=final-collapsed`; completed manager run, retained activity collapsed, final response visible.
- Viewport: 1280 × 720 CSS px; reported browser device pixel ratio 2.
- Pixel dimensions and normalization:
  - Source: 2034 × 408 px.
  - Full implementation capture: 1280 × 720 px. The in-app browser exported a CSS-sized PNG despite the reported 2× device pixel ratio.
  - Source focused normalization: proportionally downsampled to 920 × 185 px.
  - Implementation focused crop: 920 × 170 px.
  - The source and implementation use different message copy and widths, so the comparison judges the requested grouping, surface ownership, alignment, and rhythm rather than text wrapping parity.

**Findings**

- No actionable P0, P1, or P2 differences remain.
- The manager activity is visibly outside the filled response bubble and no longer shares its divider or background.
- The activity and response remain within one message wrapper, use one avatar, and retain one timestamp/actions context.
- The collapsed activity row is transparent, has no bottom border or extra padding, and sits 4 px above the response bubble.

**Required fidelity surfaces**

- Fonts and typography: Existing Silicon Interface font families, sizes, weights, and muted/foreground hierarchy are preserved. The manager label continues to read as compact status metadata.
- Spacing and layout rhythm: The activity and bubble share the same message column; their measured gap is 4 px. One avatar anchors the complete group. The activity is not rendered as a second timeline turn.
- Colors and visual tokens: The activity surface is transparent (`rgba(0, 0, 0, 0)`), while the response bubble keeps the existing received-message background token (`rgb(244, 240, 231)`).
- Image quality and asset fidelity: The existing profile avatar and Phosphor caret are reused without raster substitution or approximation.
- Copy and content: `manager finished` remains visible as the final retained stemcell status. The response copy remains independent message content.

**Full-view comparison evidence**

- The browser-rendered 1280 × 720 implementation shows the manager status and final response as one compact received-message unit beneath the completed work card.
- The composer remains visible and the revised group introduces no viewport overflow or displaced persistent controls.

**Focused region comparison evidence**

- The combined comparison shows the former nested treatment on top and the revised treatment below.
- In the revised region, `manager finished` sits directly above the response bubble with the avatar aligned to the whole group. The divider and shared bubble background visible in the source are gone.

**Primary interactions tested**

- Completed manager activity initially renders collapsed (`aria-expanded="false"`).
- Clicking the unique manager activity control expands the retained history (`aria-expanded="true"`), including the final 100% `manager finished` frame.
- Clicking again restores the collapsed state (`aria-expanded="false"`).

**Console errors checked**

- The final Turbopack browser preview reported no console errors or warnings.

**Comparison history**

- Initial source finding: the activity row was nested inside the response bubble and separated from the response by a divider.
- Fix: moved the activity to a sibling above the bubble inside the existing single message group, preserving the avatar, timestamp, actions, and collapse behavior.
- Post-fix visual evidence: `/Users/codanium/Documents/silicon/silicon-interface/artifacts/manager-message-group-comparison.png`
- No P0/P1/P2 issue was found in the post-fix comparison, so no further visual iteration was required.

**Implementation checklist**

- [x] One message group and one avatar.
- [x] Manager activity outside the response bubble.
- [x] No divider or shared activity/message background.
- [x] Collapsed by default after completion.
- [x] Retained history expands and collapses.
- [x] Browser preview has no console errors.

**Open questions**

- None.

**Follow-up polish**

- None required for this change.

final result: passed
