# Silicon Interface Desktop — Master Implementation Plan

Status: implemented; deterministic gates green; external signing, DNS, and clean-machine acceptance remain

Prepared: 16 July 2026

Scope: macOS, Windows, and Linux desktop applications

Primary repositories reviewed: silicon-interface, interface-macOS, interface-windows, interface-linux

## 1. Executive decision

Build one production desktop client with Electron and render the existing Silicon Interface React/Next application inside it. The desktop client must not reimplement chat, drafts, history, presence, delivery, or attachment semantics. Those remain owned by Interface and Glass.

The production shape is:

    Signed desktop shell
      ├── application and window lifecycle
      ├── exact navigation and permission policy
      ├── notifications, badges, tray, deep links, updates
      ├── downloads and app-owned attachment vault
      ├── small native helpers only where Electron has an OS gap
      └── typed, versioned capability handlers
                 │
                 │ narrow validated IPC
                 ▼
    Sandboxed preload
                 │
                 │ frozen window.siliconDesktop API
                 ▼
    Silicon Interface renderer
      ├── the same components and UX as the website
      ├── existing drafts, outbox, timeline, cache, and realtime logic
      └── web fallbacks when a desktop capability is unavailable
                 │
                 ▼
    Glass APIs, WebSocket, media storage, and push services

This is the closest match to the requested Discord-style model:

- Discord says its desktop application grew from its web application, uses Electron, and adds native capabilities around that shared UI. [Discord desktop architecture](https://discord.com/blog/how-discord-seamlessly-upgraded-millions-of-users-to-64-bit-architecture)
- Discord uses native modules for genuine OS gaps, invoked through renderer-to-main IPC, rather than rebuilding the product UI per operating system. [Discord WebAuthn integration](https://discord.com/blog/how-discord-modernized-mfa-with-webauthn)
- Element Desktop is an Electron wrapper whose core is Element Web. [Element Web](https://github.com/element-hq/element-web) and [Element Desktop history](https://github.com/element-hq/element-desktop)
- Signal Desktop is an Electron and TypeScript desktop messenger. [Signal Desktop](https://github.com/signalapp/signal-desktop)
- Telegram Desktop is a C++ and Qt native product. It is a useful performance and OS-integration reference, but it is not a suitable base when exact website reuse is the requirement. [Telegram Desktop](https://github.com/telegramdesktop/tdesktop)

Discord’s desktop source is proprietary. We can copy public architectural lessons and observable UX, but not claim undocumented internal behavior or copy proprietary code.

### What happens to the existing native applications

The SwiftUI/WKWebView, WPF/WebView2, and GTK/WebKitGTK repositories remain read-only reference implementations until the Electron client reaches feature parity. Their useful behavior, icons, signing knowledge, notification semantics, and OS conventions will be ported. They should then be archived, not maintained as three additional production clients.

This is a deliberate trade:

| Choice | Benefit | Cost | Decision |
| --- | --- | --- | --- |
| One Electron shell | One Chromium behavior, one bridge, one QA surface, fastest exact web parity | Larger binary and memory footprint | Selected |
| Three native webview shells | Smaller and more native per OS | Three rendering engines, three bridges, three security boundaries, triple regression surface | Reference only |
| Fully native UI | Maximum platform control | Rebuilds the website and guarantees product drift | Rejected |

If “all desktop shell code must remain Swift/C#/C” becomes an immutable business requirement, Appendix A defines the fallback. It is not the recommended route.

## 2. Outcomes and non-negotiable invariants

### Product outcomes

1. The desktop and web products use the same components, copy, status logic, drafts, outbox, history, upload behavior, and backend APIs.
2. Selecting, dropping, pasting, uploading, downloading, opening, and revealing files feels native on every OS.
3. Composer text and selected attachment bytes survive refresh, renderer crash, process crash, app update, sleep, network loss, and ordinary reboot.
4. The application has native notifications, unread badges, deep links, tray or Dock behavior, conventional shortcuts, and signed automatic updates.
5. An old shell and a newer Interface release fail safely through capability negotiation rather than breaking chat.
6. No renderer, iframe, message, or attachment can obtain unrestricted filesystem, shell, process, or authentication access.
7. macOS, Windows, and Linux releases are signed or repository-verified, built hermetically with provenance from CI, staged where the channel supports it, observable, and recoverable.

### Invariants

- Glass remains authoritative for messages, receipts, membership, media state, safety verdicts, and idempotency.
- Interface remains authoritative for browser-side drafts, outbox presentation, timeline projection, and connection UX.
- Desktop owns only operating-system capabilities and durable local file snapshots.
- A native action never sends a message by itself.
- A selected file is not considered recoverable until its local snapshot and manifest are durably committed.
- An outbox item is not deleted until an authoritative Glass acknowledgement is durably recorded.
- A downloaded file is not presented as complete until its temporary file is atomically finalized.
- Every privileged call requires an exact trusted top-frame origin, a known method, validated arguments, and an allowed capability.
- No arbitrary path read/write, arbitrary URL opener, raw IPC, shell command, environment variable, or token API is exposed to the renderer.
- The desktop project does not introduce E2EE. Transport and storage behavior stay aligned with the current product decision.

### Explicit non-goals for the first production release

- A separate native chat state engine.
- A separate desktop database that competes with Interface IndexedDB or Glass.
- Plugins, arbitrary extensions, or an embedded general-purpose browser.
- Ambient whole-disk indexing, file watchers, or broad folder access.
- Automatically opening executable downloads.
- Shipping three production webview engines.
- Loading third-party pages inside the privileged main renderer.
- A multi-day soak requirement before the first internal beta. Deterministic failure and upgrade tests are still mandatory.

## 3. Existing implementation audit

### 3.1 Shared web application

The web application is already substantially desktop-ready:

- The composer supports multi-file picker input, drag and drop, and clipboard files.
- Attachment bytes are copied to a strict-durability IndexedDB media outbox before transfer.
- Uploads are resumable multipart transfers with part checksums, retained source bytes, and crash recovery.
- Draft text, uploaded draft attachments, send outbox entries, history, notifications, presence, and connection state already have durable browser-side models.
- Web notifications, unread counts, read reconciliation, and notification deep navigation already exist.

Important gaps that the desktop work must address:

- Current attachment hashing materializes the entire Blob in memory.
- Large Blobs are duplicated into IndexedDB, which can pressure the renderer profile.
- Browser download behavior does not provide one consistent Save As, progress, resume, quarantine, and reveal flow.
- Existing desktop awareness uses ad-hoc globals such as window.__siliconBridge rather than a typed contract.
- The service worker handles push but does not yet provide a complete offline application shell.

### 3.2 Existing Electron prototype

The silicon-interface/desktop directory proves that the web build can run in Electron and already has:

- a BrowserWindow;
- sandbox, context isolation, and disabled Node integration;
- single-instance behavior;
- tray behavior;
- hide-on-close;
- an unread badge derived from the page title;
- Windows and Linux build targets.

It is a prototype, not a production base in its current form.

Release-blocking problems:

1. It starts a bundled Next server on a loopback port.
2. It rewrites outgoing Origin headers to impersonate the production website.
3. It rewrites CORS response headers back to the localhost origin.
4. It has no preload capability contract.
5. It has no attachment vault, managed downloads, deep links, or production updater.
6. Its macOS output is unsigned, arm64-only, and directory-only.
7. Its external navigation check uses string-prefix logic rather than a parsed exact-origin policy.

The Origin/CORS rewrite must be deleted before any desktop beta. Electron explicitly says not to disable or work around web security, to validate navigation and IPC senders, and to expose only narrow APIs. [Electron security checklist](https://www.electronjs.org/docs/latest/tutorial/security)

### 3.3 Existing macOS shell

Strengths to retain as behavior requirements:

- persistent WKWebView session;
- compact draggable title chrome;
- native menu shortcuts and fullscreen behavior;
- multiple-file picker;
- sanitized unique download names;
- Finder reveal;
- close-to-hide and Dock reactivation;
- sandbox, hardened runtime, camera, microphone, Downloads, and user-selected-file entitlements.

Critical gaps:

- privileged scripts are injected into every frame;
- same-window external navigation is not restricted;
- bridge messages and media permissions are not exact-origin checked;
- window visibility and authoritative unread badge contracts are missing;
- title and DOM polling can produce incorrect badges and duplicate notifications;
- release inspection remains enabled;
- there is no app-owned attachment vault, streaming hash, Save As progress, deep link, updater, APNs quit-state delivery, renderer-crash recovery, or automated test target;
- the existing DMG is ad-hoc signed, arm64-only, not notarized, and rejected by Gatekeeper.

### 3.4 Existing Windows shell

Strengths to retain:

- WebView2 persistent profile;
- custom title bar, tray, single instance, shortcuts, fullscreen, and saved window placement;
- correct basic window-state and authoritative badge hooks;
- native toast and taskbar badge;
- x64 and arm64 packaging;
- an existing Velopack update concept.

Critical gaps:

- same-window navigation is unrestricted;
- bridge message source is not validated;
- permission checks compare host rather than exact origin;
- Developer Tools are enabled in release;
- downloads and file persistence use WebView defaults;
- toast close, silence, actions, icons, and deduplication are incomplete;
- no protocol/deep-link registration;
- the WebView profile uses roaming AppData;
- artifacts are unsigned;
- no automated test project or CI;
- release documentation contradicts the implementation.

### 3.5 Existing Linux shell

Strengths to retain:

- small GTK4/WebKitGTK application;
- single-instance GApplication;
- persistent cookie session;
- native shortcuts, title chrome, notifications, launcher badge, and window-state persistence.

Production blockers:

- all origins receive camera, microphone, and notification permission;
- the bridge is injected into all frames and all URIs;
- same-window external navigation is unrestricted;
- native messages have no source-origin validation;
- download destination passes a filesystem path where WebKit expects a URI;
- failed downloads can announce success;
- notification taps can confuse event IDs with room IDs;
- authoritative badge and native window-state hooks are missing;
- there is no production package, managed updater, signing/repository verification, CI, or automated test suite;
- current guidance asks users to weaken a global AppArmor setting, which is unacceptable for release.

## 4. Target architecture

### 4.1 Processes and trust boundaries

### Main process

Trusted and minimal. It owns:

- single-instance lifecycle;
- application windows and menus;
- exact navigation, popup, permission, and external-link policies;
- persistent session configuration;
- native notifications, badges, tray, deep links, and login-at-startup;
- attachment vault and download manager;
- safe OS integration;
- update engine and restart coordination;
- crash capture and privacy filtering;
- spawning utility processes for expensive file work;
- validating every IPC sender and request.

The main process never parses chat events or decides message state.

### Preload

The only bridge between the renderer and main. It:

- runs with context isolation;
- exposes one frozen window.siliconDesktop object;
- contains no application secrets;
- validates and normalizes calls before IPC;
- wraps event listeners so Electron event objects never reach page code;
- converts a user-selected File to a native path internally only when needed;
- never returns that path to the page;
- exposes capability status and protocol version.

Electron warns not to expose raw ipcRenderer and recommends safe wrapper methods. [Electron IPC](https://www.electronjs.org/docs/latest/tutorial/ipc) and [context isolation](https://www.electronjs.org/docs/latest/tutorial/context-isolation)

### Renderer

The same Silicon Interface source tree as web. Desktop-specific code is limited to:

- feature detection through window.siliconDesktop;
- a small adapter layer with web fallbacks;
- capability/version handshake;
- native notification, file, download, deep-link, update, and lifecycle events;
- no imports from Electron or Node.

### Utility processes

Used for work that could block or destabilize the main process:

- streaming SHA-256;
- large file copy and fsync;
- archive inspection;
- thumbnail or media metadata extraction if browser APIs are insufficient;
- optional local malware preflight;
- crash-safe cleanup scanning.

Electron recommends keeping blocking work out of both the main and renderer processes. [Utility process API](https://www.electronjs.org/docs/latest/api/utility-process) and [Electron performance guidance](https://www.electronjs.org/docs/latest/tutorial/performance)

### Native helpers

Allowed only for a documented platform gap. Examples:

- macOS security-scoped bookmarks, Keychain or APNs;
- Windows package identity, WNS, Attachment Execution Services, or advanced shell integration;
- Linux xdg-desktop-portal integration where Electron APIs do not honor the package sandbox.

Each helper is signed, versioned, memory-safe where practical, and called from main or a utility process. No native helper is loaded into the renderer.

### 4.2 Renderer delivery and origin model

Production must not depend on a localhost Origin and must not rewrite Origin or CORS headers.

Target direction:

1. Build the desktop renderer from the same Interface commit as the shell.
2. Package the immutable renderer bundle inside the signed application.
3. Serve it through a security-reviewed origin model that does not depend on localhost or Origin rewriting.
4. Give it persistent IndexedDB, Cache Storage, cookies, service workers, streaming media, and code cache.
5. Allow Glass HTTP and WebSocket requests from exactly that desktop origin.
6. Bind web-session refresh and delegated WebSocket tickets to that exact origin.

Electron recommends a custom protocol instead of file URLs. [Electron protocol API](https://www.electronjs.org/docs/latest/api/protocol)

There is one mandatory Phase 0 ADR because the current HttpOnly refresh cookie is same-site and origin-bound. No candidate is approved until it passes a working prototype and security review:

- Candidate A: a secure privileged custom scheme with an explicit desktop auth broker. It must prove how the renderer calls Glass without receiving durable refresh authority.
- Candidate B: the genuine remote production HTTPS renderer. It preserves current auth and instant web parity, but weakens offline cold-start, immutable shell/renderer pairing, and the impact boundary of a web compromise.
- Candidate C: a dedicated desktop HTTPS origin with a narrowly scoped, proven local-content mechanism. It must not intercept the HTTPS scheme generally, impersonate the public Interface host, share unintended cookies, or create DNS/host-takeover risk.

The ADR must prove:

- login, refresh rotation, logout, and revocation;
- CORS preflight and credential behavior;
- WebSocket Origin and ticket binding;
- service worker and IndexedDB persistence;
- media playback and range requests;
- cold offline launch;
- no network fallback to unsigned renderer code;
- no hostname interception outside the dedicated app origin.

The ADR output is an end-to-end design, not just a boot demo. It specifies:

- interactive login and callback;
- where refresh authority lives;
- how access credentials reach network requests without becoming renderer-persistent secrets;
- refresh rotation, key rotation, revocation, logout, account switching, and device removal;
- Origin, CORS, CSRF, cookie, and WebSocket ticket binding;
- offline session behavior and recovery from clock error;
- storage isolation across stable, beta, canary, and web;
- exact threat review and backend tests.

If no packaged-origin design passes, the remote production HTTPS renderer becomes the supported model and the plan explicitly accepts its trust/offline trade. We will not invent an Origin workaround.

#### Packaged Next feasibility gate

Before choosing a packaged renderer, Phase 0 inventories and tests:

- static export compatibility for every route and dynamic segment;
- React Server Components and Next flight requests;
- middleware, redirects, route handlers, and well-known files;
- server-side rendering or request-time APIs;
- image optimization and dynamic assets;
- CSP, nonces, workers, service workers, and Cache Storage;
- deep-link route fallback;
- authentication callbacks;
- API and analytics rewrites;
- media range requests and blob URLs;
- upgrade and rollback of cached assets.

Preferred outcome: a renderer-only desktop build served from immutable packaged assets. If Interface requires a Next runtime, the fallback must still use a secure non-localhost browser origin and must document how the runtime is isolated, supervised, updated, and prevented from becoming a request proxy. The existing localhost/CORS-spoof model is never a fallback.

#### Parity promise

“Same as the website” means one source tree, one component implementation, and behavior parity at the desktop release commit. A packaged desktop cannot be guaranteed to match a web deployment made later that day.

Therefore:

- web and desktop release candidates are built from the same commit;
- Glass supports at least the current and two previous stable desktop renderer versions;
- backend/API changes are additive through that compatibility window;
- web features that need a newer shell are server-feature-gated until desktop rollout;
- a desktop-affecting Interface release reaches desktop canary from the same commit before web stable and reaches a downloadable desktop channel within 24 hours; if store review delays stable delivery, the feature remains shell-version gated;
- visual and functional parity evidence records both commits;
- renderer code is never independently hot-updated in P0.

#### Renderer release compatibility

The shell and renderer exchange:

- shellVersion;
- rendererVersion and commit;
- protocolVersion;
- minimum and maximum supported protocol;
- platform and architecture;
- capability flags;
- release channel;
- update readiness.

Rules:

- Unknown capabilities are ignored.
- A missing optional capability uses the web fallback.
- An incompatible protocol shows a safe update-required screen without destroying local drafts or outbox data.
- Web and desktop releases keep at least two bridge protocol versions compatible.
- Emergency minimum-version enforcement is reserved for security incidents.
- Every renderer artifact is hashed in the release manifest and covered by the signed application/update.

### 4.3 Session and local data layout

Use one named persistent Electron session per release channel:

- stable;
- beta;
- canary;
- test.

Never mix production and development profiles.

Application data is separated into:

    profile/
      Chromium cookies, IndexedDB, cache, and service workers

    vault/
      account-scoped attachment snapshots and manifests

    downloads/
      resumable download manifests only, not user files

    updates/
      signed update staging

    logs/
      bounded redacted diagnostics

    crash/
      bounded metadata-only crash state

Rules:

- large profile data uses local, non-roaming storage on Windows;
- account namespaces prevent one account seeing another account’s vault rows;
- ordinary cache eviction cannot delete drafts, outbox, or vault snapshots;
- logout revokes server authority first, then clears that account’s local data;
- if unsent content exists, logout explicitly explains what will be removed;
- schema migrations are versioned, transactional, restartable, and tested from every supported previous version;
- a failed migration preserves the old data and starts in recovery mode.

### 4.4 Existing-user migration

The new Electron profile cannot read WKWebView, WebView2, WebKitGTK, or the localhost prototype’s origin-scoped storage automatically. Sessions, local-only drafts, event outbox rows, settings, and attachment Blobs would otherwise be stranded.

Migration sequence:

1. Ship one final migration-capable release of each existing wrapper.
2. Ask Interface to flush every server-synchronizable draft and operation.
3. Detect local-only drafts, outbox rows, held sends, media rows, and attachment bytes.
4. If nothing local-only exists, require a fresh login in Electron and leave the old profile untouched for a rollback window.
5. If local-only state exists, offer an explicit Export to new Silicon action.
6. Interface serializes versioned metadata and streams pathless attachment bytes to the old native shell.
7. The old shell writes an authenticated, encrypted migration bundle using OS-protected key material where available and owner-only permissions everywhere.
8. Electron asks the user to authenticate, verifies that the bundle belongs to the same Carbon account, validates hashes and schema, and imports through the same draft/outbox/vault reconciliation protocols.
9. Electron writes an import acknowledgement marker only after every local authority is durable.
10. The old application retains its original data until it sees that acknowledgement or the user explicitly removes it.

The bundle never contains access or refresh credentials. HttpOnly sessions are not copied; users authenticate the new installation.

Failure behavior:

- An incomplete export leaves the old application authoritative.
- An incomplete import is restartable and cannot duplicate an outbox client ID.
- A user may cancel and continue using the old application during the migration window.
- The new application cannot archive or delete old state.
- Native wrappers are not archived until migration telemetry and support cases show the agreed completion threshold.
- Users unable to run the migration release receive a safe finish/cancel-pending-work path; local-only data is never silently abandoned.

## 5. Native bridge specification

The contract lives in silicon-interface as versioned TypeScript types and JSON schemas. Main and preload import generated validators. Native helpers receive generated bindings where needed.

### Initial capability surface

| Namespace | Methods and events | Notes |
| --- | --- | --- |
| environment | getEnvironment | Versions, platform, architecture, capabilities; no host secrets |
| window | setBadgeCount, setProgress, flash, onStateChanged | Bounded numeric values only |
| notifications | permission, requestPermission, show, close, onActivated | Internal route, never arbitrary URL |
| files | snapshotSelectedFile, pickFiles, cancelSnapshot, inspectSnapshot, releaseSnapshot | Returns opaque IDs, never raw paths |
| downloads | start, pause, resume, cancel, reveal, open, onChanged | Trusted server URLs or server-issued download IDs only |
| links | onDeepLink, openExternal | Deep links become validated routes; external protocols allowlisted |
| lifecycle | onBeforeQuit, rendererReady, flushComplete, onResume, onSuspend | Supports safe update/restart |
| updates | check, download, installWhenSafe, onStateChanged | Renderer cannot supply feed URLs |
| diagnostics | getHealthSummary, exportRedactedBundle | No message bodies, tokens, or attachment names |

P0 canonical picker flow remains the website’s file input, drop, and paste handling, followed by snapshotSelectedFile. pickFiles is reserved for portal/open-with cases and returns already-created opaque snapshot IDs; it is not a second path that returns raw native files or paths. Pathless File objects use the streaming path in Section 6.2.

### Forbidden APIs

- readFile(path)
- writeFile(path)
- deletePath(path)
- execute or shell(command)
- openAnyUrl(url)
- raw ipc send/on/invoke
- process, environment, child process, or Node module access
- cookie, access token, refresh token, API key, or safeStorage access
- arbitrary request proxy
- arbitrary notification click URL

### Validation rules

Every main-process handler must:

1. validate event.senderFrame against the exact trusted top-level origin;
2. reject subframes and destroyed/replaced frames;
3. validate method name and protocol version;
4. validate the request with a closed schema;
5. enforce field lengths, byte limits, rate limits, and allowed enum values;
6. require a recent user gesture for picker, permission, reveal, open, and external-link actions;
7. authorize the opaque resource against the active account;
8. use cancellation and a finite deadline;
9. return a stable, user-safe error code;
10. record metadata-only audit telemetry.

The website never receives Electron event objects. Event subscriptions return an unsubscribe function.

## 6. Filesystem and attachment design

### 6.1 User-facing capabilities

P0:

- select one or multiple files with the native picker;
- drag files from Finder, Explorer, Nautilus, Dolphin, or another file manager;
- paste images or files from the clipboard;
- preserve every selected file across restart before upload begins;
- show preparation, upload, scan, ready, failed, retry, and cancel states;
- resumable multipart upload using the current Glass protocol;
- remove or replace a selected attachment;
- save attachments with native Save As;
- show download progress, pause, resume, cancel, retry, open, and reveal;
- drag a completed downloaded attachment out of the app.

P1:

- open a file with Silicon and stage it into a chosen chat;
- share-target integration where the OS supports it;
- directory selection for explicitly supported product flows;
- Quick Look or native preview handoff;
- recent-download list containing only opaque download records;
- background upload continuation while the window is hidden.

P2:

- optional bandwidth limits;
- optional default download folder;
- offline upload scheduling controls;
- enterprise managed storage policy.

No phase gets unrestricted ambient filesystem access.

### 6.2 Attachment vault

The attachment vault solves the gap between “the user chose a file” and “the browser has durably copied all bytes.”

Each vault row contains:

- opaque snapshot ID;
- account ID namespace;
- room ID and draft ID;
- original display name;
- normalized display name;
- declared MIME and detected MIME;
- byte size;
- streaming SHA-256;
- source type: picker, drop, paste, open-with, or generated;
- created and last-used time;
- state and monotonic revision;
- upload session and acknowledged parts when applicable;
- owning outbox client ID after send;
- retention policy;
- no original absolute path exposed to Interface.

Storage algorithm:

    user selects or drops a file
      → validate count, type, size, and regular-file status
      → resolve symlinks and reject devices, sockets, FIFOs, and directories
      → copy to a random temporary file in the account vault
      → hash while streaming; never materialize the whole file in memory
      → fsync file and parent directory where supported
      → atomically rename to immutable snapshot ID
      → commit the manifest with strict durability
      → notify Interface that the attachment is recoverable
      → begin or resume the existing Glass multipart upload
      → wait for Glass media completion and safety scan state
      → bind media ID and snapshot ID to the durable event outbox
      → release bytes only after send acknowledgement or explicit cancellation

There are two ingestion paths behind the same snapshot API:

- Path-backed files from a picker or ordinary file-manager drop: preload resolves the backing path internally, main opens the selected object safely, and a utility process streams it into the vault.
- Pathless files such as clipboard images, camera captures, generated Blobs, and some portal-backed drops: Interface transfers bounded binary chunks through a dedicated MessagePort to the utility process. It never base64-encodes the whole object or sends it through ordinary request/response IPC.

Both paths produce the same immutable manifest and checksum. The UI uses simple states such as Preparing, Uploading, Checking, Ready, and Try again; it does not expose vault, multipart, queue, or checksum terminology.

#### Vault and Interface two-phase ownership protocol

The vault manifest and Interface IndexedDB cannot share one filesystem transaction. They use an explicit two-phase protocol with stable IDs:

1. Interface allocates sourceClientId and draft revision.
2. Main writes a PREPARING vault intent keyed by account, room, sourceClientId, and revision.
3. Main snapshots bytes and commits READY with size and hash.
4. Interface commits a media-outbox reference to that exact snapshot and revision.
5. Interface sends REFERENCE_COMMITTED to main.
6. Main records the reference acknowledgement; only now may the UI call the attachment recoverable.
7. When a send is created, Interface commits the event outbox first, including sourceClientId and immutable clientId.
8. Main records OWNED_BY_OUTBOX only after it observes that committed outbox revision.
9. Glass acknowledgement produces an Interface tombstone.
10. Main records RELEASED and removes bytes idempotently only when the tombstone covers the same account, sourceClientId, clientId, hash, and revision.

Recovery scans both authorities:

- READY without an Interface reference remains recoverable as an orphan candidate and is never auto-attached to a different draft.
- Interface reference without READY is blocked with Try again and never uploads empty bytes.
- PREPARING is resumed or safely discarded based on its open handle/temp file state.
- An event-outbox owner always outranks a draft reference.
- A release tombstone always outranks stale draft UI.
- Account switch suspends access but does not reassign ownership.
- Reconciliation is idempotent and records why an orphan is retained or removed.

The same generated transition table is tested in Interface, main, and recovery fixtures.

Crash rules:

- Crash before atomic rename: delete the unreferenced temp file on recovery.
- Crash after rename but before manifest: quarantine as orphan and reconcile by ID.
- Crash after manifest: restore the attachment chip and resume.
- Crash during multipart upload: query acknowledged parts and continue missing parts.
- Crash after upload but before outbox ownership transfer: reconcile media row and draft.
- Crash after event acceptance but before local cleanup: server acknowledgement tombstone wins; cleanup is idempotent.

The web IndexedDB media outbox remains the fallback in ordinary browsers. Desktop migrates large Blob persistence to snapshot IDs only after this two-phase protocol passes crash testing; it never keeps two independent cleanup authorities.

#### Vault confidentiality, capacity, and retention

- Encrypt vault bytes and manifests at rest with an installation/account data key protected by Keychain, DPAPI, or Secret Service where available.
- On Linux without a usable secret service, show the reduced-protection state and require an explicit product decision before storing sensitive long-lived snapshots; filesystem permissions alone are not described as encryption.
- Keys are versioned and rotation is restartable. Losing a key makes only its snapshots unavailable and never produces corrupt uploads.
- Enforce configurable per-file, per-account, and global vault quotas plus a minimum free-space reserve.
- Preflight available space, but still handle mid-copy disk exhaustion.
- Eviction may remove released cache only. It cannot remove referenced drafts, active uploads, held sends, event-outbox-owned snapshots, or unresolved migration data.
- Uploaded-but-unsent draft snapshots follow an explicit retention policy visible to the user; a blind age sweep is forbidden.
- Logout explains and then removes the account key and vault after server revocation; account switching does not.
- Backups and copied profiles contain encrypted vault material, not plaintext attachments.

### 6.3 File safety checks

- Fetch current count and size policy from Glass; do not hard-code divergent limits.
- Normalize Unicode filenames for display while preserving the user-visible name safely.
- Strip separators, control characters, trailing Windows dots/spaces, reserved device names, and traversal.
- Open the selected object once with platform-safe no-follow/share semantics, inspect that exact open handle, and stream from the same handle. A separate resolve-then-open sequence is forbidden because it is raceable.
- Reject special files, broken symlinks, reparse points that escape the granted object, recursive directories, and source mutation.
- Treat MIME and extension as hints; server safety scanning remains authoritative.
- Put archive parsing and metadata extraction in a constrained utility process.
- Use random, non-user-derived on-disk names.
- Use owner-only vault permissions.
- Never mark vault files executable.
- Never automatically open a selected or downloaded executable.
- Clear snapshots according to explicit ownership and retention, not a blind age-only sweep.
- Detect sparse files and enforce both logical-size and real free-space policy.

Electron’s webUtils can obtain a selected File’s backing path inside preload, but its documentation warns against exposing the full path to web content. [Electron webUtils](https://www.electronjs.org/docs/latest/api/web-utils)

### 6.4 Downloads

All renderer-initiated downloads flow through one main-process manager:

    validated user action or trusted attachment ID
      → request a fresh Glass download capability
      → verify trusted HTTPS source and expected media identity
      → native Save As in P0, or an explicitly approved default directory in P1
      → sanitize and deconflict filename
      → write to a random partial file
      → expose progress, pause, resume, cancel, and retry
      → validate expected size and hash when available
      → attach OS quarantine or origin metadata
      → atomically finalize
      → allow Open or Show in folder

Requirements:

- Glass download endpoints support range requests, ETag, Last-Modified, and stable size for resume.
- Interrupted state persists without persisting the signed URL past its validity.
- Resume obtains a fresh capability and validates object identity.
- macOS preserves quarantine metadata and uses Finder reveal.
- Windows preserves Mark-of-the-Web or Attachment Execution Services behavior and uses Explorer reveal.
- Linux saves with non-executable permissions and uses the desktop portal/file manager.
- The application never reports success on a failed download.
- Duplicate filenames are deterministic and race-safe.
- Download history contains no URL tokens.

Electron DownloadItem is useful for a live process, but it is not the P0 cross-restart authority. Restart-resumable downloads use a custom ranged downloader in a utility process with:

- a durable partial-file manifest;
- media/object version, expected size and hash;
- committed byte ranges;
- fresh Glass capability acquisition on every resume;
- ETag/Last-Modified validation;
- cancellation and backpressure;
- partial file created safely in the destination directory;
- no-follow/open-exclusive destination handling;
- same-filesystem atomic finalization;
- platform-native quarantine metadata before the file is offered to the user.

The manifest stores no expired presigned URL. If the immutable object identity changes, resume stops and restarts only with explicit confirmation. Electron will-download/DownloadItem remains the interception layer for ordinary browser-triggered downloads that do not promise restart resume. [Electron session downloads](https://www.electronjs.org/docs/latest/api/session) and [DownloadItem](https://www.electronjs.org/docs/latest/api/download-item)

### 6.5 Platform filesystem cases

macOS:

- user-selected access and security-scoped bookmark behavior;
- iCloud placeholders that need hydration;
- removable volumes and network shares disappearing during copy;
- filenames that differ only by case or Unicode normalization;
- Finder aliases and symlinks;
- sandboxed Save As and reveal behavior.

Windows:

- OneDrive and other cloud placeholders;
- locked files and sharing violations;
- long paths, UNC shares, removable drives, and offline network locations;
- reserved device names, alternate data streams, trailing dots/spaces, and case-insensitive collisions;
- Mark-of-the-Web and Explorer reveal;
- x64 and arm64 shell integration.

Linux:

- Flatpak document portal IDs instead of stable host paths;
- GVfs and remote mounts;
- removable media;
- Wayland and X11 drag/drop differences;
- case-sensitive collisions and invalid byte sequences;
- GNOME/KDE portal, notification, tray, and file-manager differences.

Common behavior:

- An unavailable, locked, unhydrated, or ejected source leaves the existing draft text untouched and offers Try again or Remove.
- Dropped directories are ignored unless the active feature explicitly requested folder selection.
- A source changing during copy fails the snapshot rather than uploading mixed bytes.
- Disk-full and permission failures identify the affected attachment without clearing other attachments.
- Temporary and orphan cleanup never follows symlinks or crosses the vault root.

## 7. Product and OS integration

### 7.1 Window lifecycle

- One primary window in P0; architecture permits later pop-outs.
- Second launch activates the existing instance and routes any deep link.
- Close behavior is a user preference: hide/keep running or quit.
- macOS uses Dock conventions; Windows/Linux use an optional tray.
- Save and validate window size, position, display, maximized state, and fullscreen state.
- Recover windows moved off a disconnected monitor.
- Handle DPI/scale changes without stale layout.
- Report focused, visible, minimized, hidden, suspended, and resumed states to Interface.
- Renderer crash reloads the signed renderer and restores the same chat/draft/outbox.
- Repeated crash loops show a recovery screen without clearing user data.

### 7.2 Navigation and external content

- Main renderer may navigate only within the trusted Interface app origin.
- Every URL is parsed; string prefix checks are forbidden.
- Third-party pages and any future OAuth authorization pages open in the system browser. Current OTP authentication does not depend on an OAuth callback; protocol callback work is required in the same release that introduces OAuth.
- mailto may open only after a user action.
- file, javascript, data, shell, command, and unknown schemes are denied.
- New windows are denied by default.
- If a product feature genuinely needs embedded third-party content, use a separately sandboxed WebContentsView with no preload and a separate session, never an Electron webview element. Electron does not recommend webview for new work. [Electron web embeds](https://www.electronjs.org/docs/latest/tutorial/web-embeds)

### 7.3 Deep links

Support:

- silicon://chat/ROOM
- silicon://chat/ROOM/message/EVENT
- verified HTTPS links on teamofsilicons.com
- notification actions
- open-with file activation

The parser converts a link to a closed internal route type. It rejects:

- credentials in URLs;
- unexpected hosts;
- traversal;
- oversized IDs;
- unknown query parameters where security-sensitive;
- external redirect destinations.

Cold and warm deep links use the same queue:

1. OS activation is captured by main.
2. Main validates and deduplicates.
3. The route waits for rendererReady and authenticated account state.
4. Interface navigates without a destructive full reload.
5. An inaccessible room shows the normal product error.

Electron documents different macOS, Windows, and Linux deep-link activation paths. [Electron deep links](https://www.electronjs.org/docs/latest/tutorial/launch-app-from-url-in-another-app)

### 7.4 Notifications and unread state

One event produces at most one visible OS notification.

Interface supplies:

- stable notification ID;
- owner/account ID;
- room ID and event ID separately;
- title and privacy-safe body;
- avatar/icon reference;
- sound preference;
- replacement tag;
- validated internal route;
- expiry and urgency.

Main owns:

- OS permission state;
- DND-respecting display;
- replacement and close;
- activation and actions;
- badge integration;
- deduplication;
- privacy mode that hides content;
- metadata-only delivery telemetry.

Visible-notification authority is exclusive by lifecycle state:

| Lifecycle state | Visible authority |
| --- | --- |
| Renderer focused | Interface in-app toast only |
| Process running, window hidden/unfocused | Electron main native notification only |
| Process suspended but resident | Electron main after resume/reconciliation; no service-worker duplicate |
| Process fully quit with P1 native push enabled | APNs/WNS/Linux background provider only |
| Ordinary website | Existing browser service worker |

The Electron session disables service-worker notification display while retaining any service-worker functions needed for web data. Main and quit-state push use the same Glass notification ID and persisted display ledger. Startup reconciles that ledger before showing anything.

Rules:

- authoritative unread count comes from Interface/Glass, never DOM scraping or title polling;
- badge changes do not synthesize generic duplicate notifications;
- reading or redacting an event closes matching OS notifications;
- notification activation never trusts an arbitrary URL;
- foreground users get the in-app experience and do not also get an OS banner;
- sound settings are consistent across web and desktop.

P0 supports notifications while the process is running or resident in the tray.

P1 evaluates true quit-state delivery:

- APNs native helper on macOS;
- WNS with package identity on Windows;
- on Linux, a clearly disclosed background service/tray model because no universal distribution-independent push service exists.

Quit-state delivery must share Glass notification IDs and reconciliation so it cannot double-notify with the live process.

### 7.5 Camera, microphone, screen sharing, and clipboard

- Permission request and check handlers deny every unknown capability.
- Camera, microphone, screen capture, notifications, and clipboard access require exact trusted origin and correct frame.
- Camera/microphone prompt occurs in context, not on first launch.
- Remembered decisions use OS and application permission state consistently.
- Screen sharing shows the native/system picker where available.
- Clipboard reads require a direct user action.
- Pasted files enter the same attachment vault.
- No background clipboard monitoring.

Electron notes that remote sessions otherwise approve permissions unless an application installs explicit handlers. [Electron session permission handling](https://www.electronjs.org/docs/latest/api/session)

### 7.6 Menus, shortcuts, accessibility, and international input

P0 conventions:

- New chat/search, preferences, close, quit, hide, reload-recovery, zoom, fullscreen, back/forward where safe.
- Context menus for copy, paste, spellcheck, emoji, links, attachments, and message actions.
- Never disable spellcheck, autocorrect, autocomplete, or capitalization globally.
- Support IME composition without sending early.
- Respect high contrast, reduced motion, text scale, system theme, locale, and 12/24-hour settings.
- Full keyboard traversal with visible focus.
- Screen-reader labels and announcements for connection, draft save, attachment progress, delivery/read state, and update state.

Test VoiceOver, NVDA, Narrator, JAWS where available, and Orca. Discord treats application-wide keyboard navigation as a core desktop accessibility feature. [Discord keyboard navigation](https://discord.com/blog/how-discord-implemented-app-wide-keyboard-navigation)

### 7.7 Connectivity, sleep, and recovery

The desktop shell reports OS network, suspend, resume, and proxy changes as evidence only. Interface combines them with Glass health and realtime state.

- navigator online is not treated as proof of Internet reachability.
- The existing application-wide top banner remains the only global connectivity banner.
- Chat-specific connecting state remains in that chat.
- Desktop must not expose technical queue terminology to users.
- Resume triggers bounded token, WebSocket, history-cursor, upload, download, and notification reconciliation.
- Network switches, captive portals, DNS failure, TLS failure, proxies, and clock drift have distinct diagnostics but simple user copy.

Electron also warns that online status alone does not guarantee Internet access. [Electron online/offline guidance](https://www.electronjs.org/docs/latest/tutorial/online-offline-events)

## 8. Draft, outbox, history, and update integration

Desktop does not fork the existing reliability state machines.

### Drafts

- Text remains in the current strict local journal and server draft sync.
- Desktop adds a small app-owned redundant composer journal outside the Chromium profile. It is account/room scoped, authenticated, encrypted with OS-protected key material where available, append-only by monotonic revision, and never included in diagnostics.
- Attachment manifests refer to vault snapshot IDs on desktop.
- Switching rooms flushes the outgoing draft before rendering the incoming draft.
- Cross-device draft conflicts use the existing revision and writer rules.
- A desktop capability failure never clears composer text.
- Draft migration from web Blob storage to vault IDs is idempotent.

Draft durability protocol:

1. Every accepted editor revision receives a monotonically increasing room/writer revision.
2. Interface writes its existing strict local journal and sends the same revision to main.
3. Main appends and durably flushes the redundant journal, then acknowledges that revision.
4. Room switch, blur, suspend, update, and quit request an immediate flush; ordinary typing uses a tightly bounded batching window.
5. Restore selects the highest valid revision, never a merely newest wall-clock timestamp.
6. A clear is a durable tombstone, not deletion; compaction happens only after local and server authorities cover it.
7. Profile corruption or origin migration restores from the app-owned journal before cache rebuild.

The guarantee is precise: every revision acknowledged durable by the composer survives renderer/process crash, normal reboot, app update, cache rebuild, and origin migration in the deterministic fault suite. Hardware failure before the OS completes the acknowledged fsync, storage-controller loss, deliberate data deletion, and unavailable Linux secret storage remain documented physical limits; the UI must not claim mathematically impossible “never” semantics.

### Sends

- Interface allocates the immutable client ID.
- The event outbox remains the exactly-once recovery authority.
- Desktop file snapshots are source material, not send authority.
- The five-second Silicon hold behavior stays in Interface/Glass and is not reimplemented in main.
- Quit, restart, or update cannot bypass a hold or send a draft.

### History and cache

- Existing IndexedDB timeline and cursor data live in the persistent named session.
- Desktop updates never delete the profile.
- Cache schema versions are compatible across at least one rollback.
- Corrupt cache recovery preserves outbox, drafts, and vault before rebuilding timeline data.

### Safe restart/update handshake

    updater requests restart
      → main emits beforeRestart with deadline
      → Interface flushes active composer and draft journal
      → Interface commits pending outbox state
      → vault commits pending snapshot manifests
      → Interface returns safe, busy, or blocked
      → safe: install and restart
      → busy: defer and retry after transfer
      → blocked: keep update staged and explain that unsaved work is protected

Forced security updates still take the shortest safe path and never erase unsent content.

This handshake is not the durability mechanism. Draft, outbox, and vault state are continuously committed before an updater asks to restart. A hung or compromised renderer can cause the update to defer, but cannot be trusted to make unsaved work safe. Force quit and process kill are covered by the same continuous journals and reconciliation.

## 9. Security and privacy baseline

### 9.1 Electron hardening

- Stay within Electron’s currently supported stable-major window and schedule monthly upgrade review.
- nodeIntegration disabled.
- contextIsolation enabled.
- renderer sandbox enabled.
- webSecurity enabled.
- no mixed or insecure content.
- restrictive CSP.
- no experimental Blink features.
- explicit permission check and request handlers.
- exact navigation and popup policies.
- exact IPC sender-frame validation.
- no raw Electron APIs in renderer.
- no privileged third-party frames.
- production Developer Tools disabled unless a deliberate support mode is activated.
- no arbitrary shell.openExternal input.
- no file URL renderer.
- no Origin or CORS rewriting.

Electron’s release policy supports only a moving window of stable majors, so dependency upgrades are continuing operational work, not a one-time launch task. [Electron release timelines](https://www.electronjs.org/docs/latest/tutorial/electron-timelines)

### 9.2 Fuses and application integrity

Production fuses:

- enable cookie encryption;
- enable embedded ASAR integrity where supported;
- load application code only from ASAR;
- disable RunAsNode;
- disable NODE_OPTIONS;
- disable CLI inspect arguments;
- disable unused Electron features.

ASAR integrity and OnlyLoadAppFromAsar must be enabled together where supported. [Electron fuses](https://www.electronjs.org/docs/latest/tutorial/fuses) and [ASAR integrity](https://www.electronjs.org/docs/latest/tutorial/asar-integrity)

Shell-only secrets may use Electron safeStorage or a narrowly scoped native keychain helper. Linux protection depends on the available secret service and can fall back to weaker storage, so the product must detect and disclose that state rather than describe it as a universal hardware vault. The preferred session-refresh design remains an HttpOnly, origin-bound cookie proven by the Phase 0 origin spike. [Electron safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage)

### 9.3 Threat cases and required tests

| Threat | Required control |
| --- | --- |
| Hostile message link navigates renderer | Exact navigation denial and safe external opener |
| Hostile iframe calls bridge | Main-frame-only preload exposure and senderFrame validation |
| XSS calls filesystem API | Narrow opaque capabilities, user gesture, no raw paths |
| Malformed IPC | Closed schema, limits, deadline, rate limit |
| Path traversal or malicious filename | Random vault name and strict display/save sanitization |
| Symlink swap or special file | Open/copy safely, verify regular file, immutable snapshot |
| Huge file exhausts memory | Streaming copy/hash in utility process |
| Compromised update feed | Signed manifest and artifact, pinned channel, staged rollout |
| Old shell with new renderer | Protocol handshake and graceful capability fallback |
| Crash report leaks chats | Metadata allowlist and redaction before capture |
| Local profile copied | OS account permissions and encrypted cookies; no claims of E2EE |
| Third-party OAuth page gains bridge | System browser or fully separate unprivileged view |
| Downloaded executable launches | Never auto-open; preserve OS quarantine |

### 9.4 Diagnostics and privacy

Collect:

- app, renderer, protocol, OS, architecture, and channel versions;
- startup stage timings;
- renderer/main/utility crash category;
- update state;
- bridge method name and error code;
- attachment size bucket and state transition, not name or content;
- connectivity class;
- notification display outcome;
- bounded resource metrics.

Never collect:

- message or draft bodies;
- attachment filenames or contents;
- Carbon/Silicon private credentials;
- access, refresh, API, push, presigned URL, or WebSocket ticket tokens;
- full room or event URLs;
- clipboard contents;
- arbitrary filesystem paths.

Crash upload is disclosed and follows product consent policy. Exported support bundles are previewable and redacted before the user shares them.

Electron crash reporting is based on Crashpad; the payload must be explicitly constrained. [Electron crashReporter](https://www.electronjs.org/docs/latest/api/crash-reporter)

## 10. Packaging, signing, and updates

### 10.1 Common release pipeline

Every release:

1. pins Node, package manager, Electron, compiler, and build image versions;
2. builds renderer and shell from one immutable commit;
3. runs lint, types, unit, integration, bridge, and security tests;
4. generates an SBOM and dependency/license report;
5. packages each supported OS/architecture;
6. signs in a protected CI signing job;
7. notarizes or repository-signs as required;
8. installs and launches the final artifact on clean machines;
9. tests upgrade from the two previous stable versions;
10. publishes immutable hashes, provenance, and update metadata;
11. releases canary, then beta, then staged stable;
12. automatically halts rollout on crash, startup, login, or draft-safety regression.

No signing certificate or long-lived cloud secret is stored in the repository.

Renderer and shell are one atomic signed release in P0 and P1. Differential package transfer may optimize an updater, but there is no independent renderer hot-code channel.

### 10.2 macOS

Artifacts:

- universal arm64 and x64 application;
- signed and notarized DMG;
- update artifact required by the selected updater.

Requirements:

- Developer ID Application signing;
- hardened runtime;
- least-privilege entitlements;
- notarization and stapling;
- privacy manifest;
- correct camera and microphone usage strings;
- valid Dock, notification, deep-link, and file-association metadata;
- clean Gatekeeper validation on a machine that has never trusted the developer.

Electron requires signing for public distribution and for macOS automatic updates. [Electron code signing](https://www.electronjs.org/docs/latest/tutorial/code-signing) and [Apple Hardened Runtime](https://developer.apple.com/documentation/security/hardened-runtime)

### 10.3 Windows

Primary artifact:

- signed MSIX for clean identity, install/uninstall, protocol registration, notifications, and managed updates.

Fallback:

- signed NSIS installer for environments where MSIX is unsuitable.

Architectures:

- Windows 10/11 x64;
- Windows 11 arm64 after the native dependency matrix passes.

Requirements:

- stable package identity and AppUserModelID;
- trusted signing through the Microsoft Store, Azure Artifact Signing, or an approved certificate;
- SmartScreen reputation plan;
- per-user local non-roaming profile;
- clean upgrade, downgrade-block, uninstall, and repair tests;
- no administrator requirement for ordinary per-user install.

[MSIX overview](https://learn.microsoft.com/en-us/windows/msix/overview) and [MSIX signing](https://learn.microsoft.com/en-us/windows/msix/package/sign-msix-package-guide)

### 10.4 Linux

Primary managed channel:

- Flatpak with xdg-desktop-portal file, notification, secret, and open-uri integration.

Secondary artifacts:

- deb;
- rpm;
- AppImage for direct portable use where supportable.

Architectures:

- x64 first;
- arm64 after native modules, Electron, and CI runners pass.

Requirements:

- Wayland and X11;
- portal-first file access;
- scoped sandbox permissions;
- signed repository/update metadata;
- no instruction to weaken global AppArmor or user-namespace security;
- distro package updates are authoritative.

Electron has no built-in Linux auto-updater and recommends the distribution package manager. [Electron autoUpdater](https://www.electronjs.org/docs/latest/api/auto-updater/) and [Flatpak Electron guidance](https://docs.flatpak.org/en/latest/electron.html)

### 10.5 Release channels and rollback

Channels:

- canary: team and automated daily builds;
- beta: invited real users and release candidates;
- stable: staged production.

Stages for channels that support controlled percentage rollout:

- 1 percent;
- 5 percent;
- 20 percent;
- 50 percent;
- 100 percent.

Promotion gates compare:

- crash-free sessions;
- startup success;
- login/refresh success;
- renderer recovery;
- draft and outbox recovery;
- upload/download failure;
- notification activation;
- update completion;
- resource budgets.

Recovery:

- stop update manifest promotion immediately;
- keep previous signed artifact available;
- renderer/profile schema remains readable by one previous stable version;
- disable a faulty native capability through a signed configuration kill switch;
- prefer a signed forward-fix release because package managers, stores, and migrated schemas do not all support safe binary downgrade;
- allow actual downgrade only on a channel whose package identity, updater, and data-schema gate have explicitly passed that path;
- never remotely clear local user data.

### 10.6 Updater matrix and metadata security

| Distribution | Update authority | Rollout/recovery model |
| --- | --- | --- |
| macOS direct DMG | Selected signed macOS updater using its required signed update artifact | Staged feed where supported; stop, kill switch, forward fix; downgrade only after schema test |
| Windows MSIX | Microsoft Store or signed App Installer feed | Store/App Installer policy; repair and forward update; separate identity from NSIS |
| Windows NSIS fallback | Selected direct Electron updater | Separate feed and identity; staged feed; never cross-grade silently to MSIX |
| Linux Flatpak | Flathub or signed Flatpak repository | Branch/channel promotion and repository rollback/forward fix |
| Linux deb/rpm | Signed APT/DNF repository | Repository version policy; package-manager authority |
| Linux AppImage | Manual replacement unless a separately reviewed updater is selected | No P0 automatic-update or percentage-rollback promise |

Every non-store update manifest has:

- detached signature from a dedicated online release key whose root is protected offline;
- artifact hash, size, version, platform, architecture, channel, and minimum compatible data schema;
- issue and expiry time;
- monotonic anti-replay sequence;
- downgrade policy;
- signing-key ID and documented rotation/revocation procedure;
- HTTPS delivery in addition to signature verification.

Timestamped/notarized artifacts are not promised to be bit-for-bit reproducible. The promise is hermetic, repeatable source builds, recorded inputs, SBOM, signed provenance, and verification that the final signed artifact contains the tested payload.

## 11. Performance and quality budgets

These are proposed launch gates and should be measured on agreed reference hardware:

| Metric | P0 target |
| --- | --- |
| Warm launch to usable UI | p95 at or below 2 seconds |
| Cold launch to usable UI | p95 at or below 4 seconds |
| Resume from hidden/sleep | p95 at or below 2 seconds |
| Renderer crash recovery | UI restored within 4 seconds, zero committed draft loss |
| Idle CPU after sync settles | below 1 percent on reference hardware |
| Idle memory | no more than one equivalent Chromium tab plus 175 MB shell overhead |
| Composer input | no visible blocking during draft, hash, upload, or update work |
| Scroll and animations | 60 fps target with reduced-motion compliance |
| Attachment selection feedback | visible state within 250 ms |
| Update startup regression | less than 10 percent |
| Crash-free sessions during beta | at least 99.8 percent |
| Draft/outbox loss in fault suite | zero |

Budgets are enforced in CI where stable and on release hardware otherwise. Electron and Discord both emphasize measuring startup, memory, CPU, and code loading rather than assuming framework defaults are fast. [Electron performance](https://www.electronjs.org/docs/latest/tutorial/performance) and [Discord code splitting](https://discord.com/blog/how-discord-maintains-performance-while-adding-features)

## 12. Test strategy and release gates

### 12.1 Automated layers

### Interface tests

Run the existing web tests unchanged inside the desktop renderer for:

- drafts;
- cross-device draft conflict;
- outbox and retry;
- five-second holds;
- history and pagination;
- receipt/delivery/read status;
- realtime reconnect;
- attachment upload and recovery;
- notification reconciliation;
- offline and degraded UX.

### Main and preload unit tests

- URL and origin parser;
- sender-frame validator;
- every bridge schema;
- capability negotiation;
- filename normalizer;
- vault manifest transitions;
- cleanup ownership;
- download transitions;
- deep-link parser;
- notification deduplication;
- restart handshake;
- update channel verifier;
- log redaction.

### Contract tests

One fixture website calls every supported and forbidden bridge path. It runs against:

- current shell/current renderer;
- current shell/previous renderer;
- previous shell/current renderer;
- missing optional capability;
- hostile iframe;
- navigated hostile top frame;
- malformed, oversized, repeated, cancelled, and timed-out requests.

### Electron integration tests

Playwright Electron covers:

- clean launch and login;
- persistent session;
- room navigation;
- draft across reload and restart;
- crash and recovery;
- picker/drop/paste upload with test hooks;
- interrupted/resumed upload;
- download lifecycle;
- deep links cold and warm;
- notification activation;
- tray and window state;
- update-safe restart.

Playwright’s Electron support does not replace physical native-dialog and packaging tests. [Playwright Electron](https://playwright.dev/docs/api/class-electron)

### Backend integration tests

Glass tests:

- exact desktop CORS origin;
- web refresh cookie rotation and revocation;
- WebSocket origin/ticket binding;
- multipart idempotency and resume;
- download range/ETag/Last-Modified;
- notification deduplication;
- app version and device registration;
- revoked or unsupported shell behavior.

### 12.2 Adversarial and failure cases

Mandatory deterministic cases:

- offline before launch;
- disconnect at every draft, snapshot, multipart, send, receipt, and download boundary;
- sleep during upload and WebSocket reconnect;
- renderer kill, main kill, utility kill, and machine reboot;
- disk full and quota exceeded;
- read-only or revoked file permission;
- attachment source changed after selection;
- symlink replacement;
- 0-byte, very large, sparse, Unicode, reserved-name, archive bomb, and executable files;
- malicious MIME/extension mismatch;
- duplicate filename race;
- captive portal, DNS failure, TLS interception, proxy change, and clock skew;
- stale refresh cookie and simultaneous refresh;
- deep-link flood and malformed route;
- notification duplicate/read/redaction races;
- hostile iframe, popup, redirect, and IPC;
- update downloaded while composer, upload, download, or hold is active;
- upgrade and rollback with old drafts/outbox/vault.

### 12.3 Physical OS matrix

macOS:

- Apple Silicon and Intel;
- minimum supported macOS, current minus one, current;
- multi-monitor, Retina/non-Retina where available;
- VoiceOver, camera, microphone, notification, Gatekeeper, sleep/wake.

Windows:

- Windows 10 22H2 and supported Windows 11 releases;
- x64 and arm64 where shipped;
- 100, 125, 150, and 200 percent scale;
- Narrator/NVDA, toast activation, SmartScreen, install/update/repair.

Linux:

- Ubuntu LTS, Debian stable, and current Fedora;
- GNOME and KDE;
- Wayland and X11;
- Flatpak plus direct-package smoke;
- Orca, portals, tray variance, notification daemons, suspend/resume.

Exact minimum versions are pinned during Phase 0 against the selected Electron major and reviewed quarterly.

### 12.4 User acceptance checklist

Before production, a user must be able to:

1. install without unsafe bypass instructions;
2. log in and relaunch without logging in again;
3. use every website chat flow with visual parity;
4. type a draft, kill the app, reopen, and recover it;
5. select, drop, and paste multiple files;
6. interrupt an upload and resume after restart;
7. send exactly once during network failure;
8. see waiting, delivered, and read states exactly as web;
9. download, cancel, resume, open, and reveal a file;
10. receive one notification, click it, and reach the exact chat;
11. use keyboard, IME, zoom, high contrast, reduced motion, and screen reader;
12. update without losing a draft or active outbox item;
13. uninstall cleanly while retaining or deleting user data according to an explicit choice.

## 13. Implementation work breakdown

All P0 items are required before public beta. P1 follows a stable base. P2 is enhancement work.

### Phase 0 — architecture proof and repository preparation

Priority: P0

Tasks:

- approve the one-Electron-shell direction;
- preserve the current dirty worktrees and create an implementation branch;
- inventory current Electron dependencies and artifacts;
- complete the packaged Next compatibility inventory and prototype every viable renderer-delivery candidate;
- write and security-review the end-to-end desktop auth design;
- prove login, refresh, logout, account switch, cookie/CORS/CSRF, WebSocket, service worker, IndexedDB, media, and offline boot;
- prototype the existing-native-profile migration export/import on one OS;
- specify and model-check the draft redundant journal and vault/IndexedDB two-phase transition tables;
- choose the final app ID, bundle IDs, protocol scheme, desktop origin, and release channels;
- select one updater authority per distribution artifact and document identities that cannot cross-grade;
- define supported OS/architecture matrix;
- define window.siliconDesktop v1 schemas;
- create threat model and data-flow review;
- remove Origin/CORS rewriting from the target branch;
- freeze native wrappers except for security fixes needed by current testers.

Exit criteria:

- one development-packaged build boots the candidate Interface delivery model on all three OSes;
- the renderer origin/delivery ADR and complete auth data flow are approved;
- every Next route/runtime requirement has a supported packaged or remote answer;
- no Origin/CORS spoofing;
- login, refresh rotation/revocation, logout, account switching, and WebSocket binding work;
- hostile iframe cannot call a privileged API;
- one renderer profile survives restart;
- one old native profile with local-only draft/outbox/media data migrates without loss or duplication;
- draft/vault two-domain crash transitions have an executable reference model;
- updater matrix and parity/compatibility promise are approved.

### Phase 1 — hardened shell and bridge

Priority: P0

Tasks:

- migrate desktop main and preload to typed TypeScript;
- implement exact navigation, popup, external-link, permission, and IPC policies;
- implement named persistent sessions;
- add protocol/capability handshake;
- implement window state, badge, progress, tray/Dock, menus, and shortcuts;
- implement renderer crash recovery and recovery UI;
- add deep-link parser and single-instance route queue;
- add release-only security fuses and Developer Tools policy;
- add metadata-only logging and health summary;
- add unit and bridge-contract test harness.

Exit criteria:

- security checklist passes;
- all forbidden bridge calls fail;
- old/new protocol fixtures degrade safely;
- window state and badges match Interface;
- crash recovery preserves draft/outbox.

### Phase 2 — exact Interface parity

Priority: P0

Tasks:

- remove native script monkey-patching and DOM/title polling;
- replace ad-hoc globals with desktop adapter;
- run all Interface chat tests in Electron;
- validate auth, onboarding, settings, search, profiles, contacts, media, voice, and notifications;
- add visual screenshot comparison against web;
- add offline application shell and cached history boot;
- ensure user-facing connection language stays simple;
- validate five-second Silicon holds and cancel behavior unchanged.

Exit criteria:

- no functional fork between web and desktop;
- screenshot and behavior parity accepted at supported sizes;
- all core Interface reliability tests pass in desktop.

### Phase 3 — attachment vault and upload durability

Priority: P0

Tasks:

- implement account-scoped vault and manifest;
- implement streaming copy/hash utility process;
- connect picker, drop, paste, and open-with to snapshots;
- adapt media outbox to snapshot IDs on desktop;
- retain browser Blob fallback;
- implement crash reconciliation and cleanup;
- add progress, cancel, retry, replacement, and disk-full UX;
- run boundary failure matrix;
- verify server scan and send ownership transitions.

Exit criteria:

- selected bytes survive crash/restart before upload;
- large files do not require whole-file memory;
- upload resumes missing parts only;
- no attachment is sent twice or deleted before ownership ends.

### Phase 4 — managed downloads and filesystem UX

Priority: P0

Tasks:

- implement one download manager;
- add native Save As and approved-default-folder preference;
- add pause/resume/cancel/retry;
- add safe filename, partial file, hash/size verification, and atomic finalization;
- add OS quarantine/origin metadata;
- add Open and Show in folder after completion;
- add drag-out for completed files;
- update Glass for reliable range resume;
- test malicious and unusual files.

Exit criteria:

- no failed download announces success;
- restart resume works;
- executable downloads are never auto-opened;
- OS security metadata is preserved.

### Phase 5 — notifications, deep links, and lifecycle

Priority: P0 for resident-process behavior; P1 for quit-state delivery

Tasks:

- implement typed native notifications;
- eliminate duplicates from service worker, in-page, and badge paths;
- reconcile read/redaction across OS notifications;
- implement cold/warm deep links and verified HTTPS links;
- implement close/quit/startup preference;
- implement safe restart/update handshake;
- implement sleep/resume and proxy/network recovery;
- evaluate APNs/WNS/Linux background delivery.

Exit criteria:

- one event produces at most one banner;
- notification click opens the right account and room;
- update/sleep/restart preserves user work.

### Phase 6 — packaging, signing, updates, and CI

Priority: P0

Tasks:

- build macOS universal signed/notarized artifacts;
- build signed Windows x64 and qualified arm64 artifacts;
- build Flatpak and secondary Linux artifacts;
- create canary/beta/stable feeds;
- implement signed channel-specific updates, rollout controls, kill switch, and forward-fix recovery;
- add SBOM, provenance, hashes, and release notes;
- install/upgrade test final artifacts on clean runners;
- add rollout dashboards and automatic stop conditions.

Exit criteria:

- clean OS machines install without unsafe bypass;
- updates are signed and defer safely;
- two-version upgrade passes everywhere, and downgrade passes only on channels that claim to support it;
- rollout can stop without data loss.

### Phase 7 — accessibility, performance, and final QA

Priority: P0 for core accessibility and budgets; P1 for extended assistive matrix

Tasks:

- keyboard/IME/screen-reader audit;
- zoom, contrast, reduced-motion, and theme audit;
- startup/idle/memory/CPU profiling;
- native dialog and multi-monitor physical tests;
- execute adversarial/failure suite;
- complete privacy/security review;
- internal dogfood and invited beta;
- resolve all P0 defects.

Exit criteria:

- user acceptance checklist passes;
- P0 budgets pass or have an approved measured exception;
- zero known draft/outbox loss;
- zero critical/high security findings;
- final release candidate is signed/repository-verified with SBOM and provenance.

### Phase 8 — staged production and follow-up

Priority: P0 rollout, then P1/P2

Tasks:

- release stable in stages;
- monitor gates at each stage;
- publish support and recovery documentation;
- archive the three duplicate native shells after parity evidence;
- begin quit-state push, share targets, folders, Quick Look, bandwidth controls, and enterprise policy based on P1 order;
- maintain monthly Electron/security upgrades and quarterly OS matrix review.

Exit criteria:

- 100 percent stable rollout;
- no unresolved P0 regression;
- native reference repositories archived with final parity notes;
- operational ownership and update cadence assigned.

## 14. Feature inventory and priority

| Area | P0 | P1 | P2 |
| --- | --- | --- | --- |
| Renderer | Same Interface bundle, offline shell, version handshake | Faster atomic application updates | Enterprise channel pinning |
| Security | Sandbox, isolation, strict origin/IPC/navigation/permissions, fuses | External audit | Managed policy reporting |
| Migration | Native/profile export-import for local-only work | Guided cleanup of legacy installs | Enterprise migration policy |
| Drafts/outbox | Full existing reliability parity, redundant composer journal, and safe restart | Cross-profile diagnostics | Admin recovery tooling |
| Files in | Picker, multi-select, drop, paste, durable snapshots | Open-with, share target, folders | Managed folder policy |
| Upload | Resume, checksum, crash/reboot recovery, cancel/retry | Background continuation | Bandwidth scheduling |
| Downloads | Save As, progress, pause/resume, safe finalize, reveal/open, drag-out | Default folder, Quick Look | Retention policy |
| Notifications | Native resident-process, dedupe, click, close/read sync | Quit-state APNs/WNS/background strategy | Rich actions |
| Window | Single instance, state, tray/Dock, crash recovery | Pop-out media windows | Multi-window chats |
| Links | Internal deep links and verified HTTPS | OAuth callback and file association expansion | Admin deep-link policy |
| Media | Camera/mic exact permission, voice parity | Screen share/calls enhancements | Advanced device routing |
| Accessibility | Keyboard, IME, labels, zoom, contrast, reduced motion | Full assistive-device lab | Personalized shortcuts |
| Updates | Signed, channel-appropriate rollout, safe restart, stop/forward-fix recovery | Delta optimization and proven channel-specific downgrade | Enterprise deferred updates |
| Diagnostics | Redacted health and crash metadata | User-exported bundle | Remote assisted diagnostics with consent |
| Packaging | DMG, MSIX/NSIS, Flatpak plus direct Linux | Stores and repositories | Managed deployment catalog |

## 15. Proposed repository structure

Use silicon-interface as the product monorepo:

    silicon-interface/
      src/
        desktop/
          adapter.ts
          contract.ts
          fallbacks.ts
      desktop/
        main/
          app.ts
          windows.ts
          navigation.ts
          permissions.ts
          notifications.ts
          downloads.ts
          vault.ts
          updates.ts
          diagnostics.ts
        preload/
          index.ts
          bridge.ts
        shared/
          contract.ts
          schemas.ts
          errors.ts
        utility/
          file-worker.ts
        native/
          macos/
          windows/
          linux/
        build/
          icons/
          entitlements/
          manifests/
          flatpak/
        tests/
          unit/
          contract/
          electron/
          fixtures/
        scripts/
          build-desktop
          sign-desktop
          publish-desktop
          verify-desktop

Generated artifacts and secrets remain untracked.

The current interface-macOS, interface-windows, and interface-linux repositories receive:

- a final audit reference;
- a mapping from each behavior to the new desktop implementation;
- a deprecation notice after parity;
- no new product logic.

## 16. Required product and account inputs

Before Phase 6, the project needs:

- final public product name;
- final macOS bundle ID, Windows package identity, Linux application ID;
- Apple Developer team with Developer ID and notarization credentials;
- Windows signing or Microsoft Store/Azure Artifact Signing decision;
- Flathub or Linux repository ownership decision;
- a release domain and update artifact storage;
- privacy/crash-reporting consent decision;
- supported minimum OS decision;
- close-to-tray and launch-at-login defaults;
- notification content privacy default;
- default download behavior;
- stable, beta, and canary tester groups.

Only the identity/origin decisions block Phase 0. Signing credentials are not needed to begin architecture and development.

## 17. Definition of done

The desktop application is done only when:

- one shared Interface implementation powers web, macOS, Windows, and Linux;
- the exact current chat reliability state machines run unchanged;
- every native capability has a web fallback and a tested permission boundary;
- no localhost/CORS/Origin spoof remains;
- drafts and attachment snapshots survive every tested crash and update boundary;
- sends remain idempotent and delivery/read status matches Glass;
- uploads and downloads resume safely;
- native notifications, badges, deep links, tray/Dock, menus, and shortcuts behave conventionally;
- all supported final packages are signed/repository-verified and install cleanly;
- updates, stop/kill-switch response, and forward-fix recovery preserve user data;
- accessibility and performance gates pass;
- security review has no unresolved critical/high issue;
- the user acceptance checklist passes on real macOS, Windows, and Linux machines;
- the release is deployed gradually where its channel supports it, with observable stop, kill-switch, and recovery controls.

## Appendix A — native-wrapper fallback

If native-only shell code is mandatory, keep:

- SwiftUI + WKWebView on macOS;
- C# + WebView2 on Windows;
- C + GTK4/WebKitGTK on Linux.

The rest of this plan still applies, but window.siliconDesktop must be implemented three times with generated schemas and the same conformance fixture.

Additional cost and risk:

- Safari/WebKit, Chromium/WebView2, and WebKitGTK can render and behave differently;
- every security fix must be implemented and reviewed three times;
- every upload/download and bridge feature needs three native implementations;
- automated UI tooling differs by OS;
- release cadence is limited by the slowest platform;
- exact pixel/behavior parity cannot be guaranteed by one renderer build.

Mandatory first fixes on this fallback route:

1. exact main-frame origin enforcement on all three shells;
2. deny external same-window navigation;
3. validate every native message source;
4. deny permissions outside the exact Interface origin;
5. replace title/DOM polling with one typed badge/window-state contract;
6. fix Linux download URI/error semantics;
7. add the same opaque attachment-vault contract;
8. sign, package, update, and test each app independently.

References: [WKWebView](https://developer.apple.com/documentation/webkit/wkwebview/), [WebView2 security](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/security), and [WebKitGTK WebView](https://webkitgtk.org/reference/webkit2gtk/stable/class.WebView.html)

## Appendix B — decisions captured

- ADR-001: use one Electron shell with the shared Interface renderer.
- ADR-002: preserve native code only as reference or narrowly scoped native helpers.
- ADR-003: package the renderer from the same commit; do not load arbitrary remote code into a privileged renderer.
- ADR-004: no localhost Origin spoofing or CORS header rewriting.
- ADR-005: keep chat state in Interface/Glass.
- ADR-006: use a versioned, typed, capability-based bridge.
- ADR-007: expose opaque filesystem resources, never arbitrary paths.
- ADR-008: snapshot selected bytes before claiming attachment durability.
- ADR-009: use signed staged updates with a draft/outbox flush handshake.
- ADR-010: make security, accessibility, failure recovery, and final-package verification release gates.
