# Desktop verification record

Date: 2026-07-16

Release candidate version: `0.1.0`

Target platforms: macOS x64/arm64, Windows x64/arm64, Linux x64/arm64

This record distinguishes implementation evidence from the external signing and
clean-machine checks that cannot be truthfully replaced by cross-compilation.

## Deterministic gates

The exact current tree passed:

| Gate | Result |
| --- | --- |
| Deployment-contract tests | 12/12 passed |
| Dependency advisory gate | passed; 847 locked packages, 0 advisories at the high threshold |
| Desktop TypeScript + policy/release/smoke/signing tests | 62/62 passed |
| Interface TypeScript | passed |
| Chat reliability suite in the committed desktop tree | 252/252 passed |
| Next.js 16.2.6 production webpack build | passed; 14 routes generated |
| Workflow YAML parse | passed |
| CloudFormation template validation | passed in `us-east-1` |

Commit `22fa08f` passed the complete six-architecture native GitHub Actions
Desktop workflow
([run 29525903554](https://github.com/teamofsilicons/silicon-interface-web/actions/runs/29525903554)):

| Native job | Job ID | Result | Uploaded artifact ID |
| --- | --- | --- | --- |
| Shared Ubuntu test/build gate | `87714142999` | passed | n/a |
| macOS 14 arm64 package/runtime | `87714585363` | passed | `8386727221` |
| macOS 15 Intel x64 package/runtime | `87714585402` | passed | `8386790346` |
| Windows 11 ARM arm64 package/runtime/install | `87714585334` | passed | `8386870150` |
| Windows Server 2022 x64 package/runtime/install | `87714585367` | passed | `8386817955` |
| Ubuntu 22.04 ARM arm64 package/runtime/install | `87714585371` | passed | `8386755215` |
| Ubuntu 22.04 x64 package/runtime/install | `87714585391` | passed | `8386759151` |

The Windows ARM64 job used a timestamped, runner-local engineering
Authenticode identity and independently proved that this identity is rejected
by the exact public-release publisher gate. It then verified the generated
updater SHA-512, launched the unpacked ARM64 application against
`https://interface.teamofsilicons.com/`, remained healthy for ten seconds,
performed the real default per-user NSIS install, verified the installer,
installed application, and uninstaller signatures, launched the installed
application against production, remained healthy for another ten seconds, and
confirmed uninstall removed the application.

The ARM64 installer now uses an architecture-scoped real ZIP payload with
electron-builder differential packaging disabled. This is required because
the x86 NSIS 7z plug-in silently omitted ARM64-transformed EXE/DLL entries. A
local extraction of the corrected installer identified the embedded payload as
ZIP and completed `unzip -t` without errors, including the ARM64 executable and
native DLLs. Windows x64 retains its smaller differential installer and EXE
blockmap. The signed ARM64 updater intentionally downloads the complete
installer without first requesting a missing blockmap.

Commit `2a9bc8b` passed the complete native GitHub Actions Desktop workflow
([run 29513081958](https://github.com/teamofsilicons/silicon-interface-web/actions/runs/29513081958)):

| Native job | Job ID | Result | Uploaded artifact ID |
| --- | --- | --- | --- |
| Shared Ubuntu test/build gate | `87671253344` | passed | n/a |
| macOS 14 arm64 package/runtime | `87671745782` | passed | `8381575462` |
| Windows Server 2022 x64 package/runtime/install | `87671745750` | passed | `8381652242` |
| Ubuntu 22.04 x64 package/runtime/install | `87671745781` | passed | `8381617628` |

The exact cloud-signer updater identity path was additionally integration-built
with a punctuation-bearing publisher name. Electron-builder serialized that
name into the packaged `resources/app-update.yml`, and the verifier decoded the
YAML scalar and required a byte-for-byte match. The release path also compares
the certificate's Authenticode Simple Name against the same protected GitHub
variable before any signed artifact can publish.

Commit `dd5ba18` passed the complete native GitHub Actions Desktop workflow
([run 29510506523](https://github.com/teamofsilicons/silicon-interface-web/actions/runs/29510506523)):

| Native job | Job ID | Result | Uploaded artifact ID |
| --- | --- | --- | --- |
| Shared Ubuntu test/build gate | `87662477366` | passed | n/a |
| macOS 14 arm64 package/runtime | `87662938861` | passed | `8380511548` |
| Windows Server 2022 x64 package/runtime/install | `87662938845` | passed | `8380645602` |
| Ubuntu 22.04 x64 package/runtime/install | `87662938939` | passed | `8380569280` |

This run includes the final dependency-audit gate, Electron 42.7.0 package,
payload-first stable-feed publisher, and digest-verified GitHub draft-release
transaction. The unsigned Windows branch candidate was rejected by the release
signature check as expected before its isolated engineering runtime/install
checks; unsigned output was not promoted.

Commit `9d30221` passed the complete native GitHub Actions Desktop workflow
([run 29496175052](https://github.com/teamofsilicons/silicon-interface-web/actions/runs/29496175052)):

| Native job | Job ID | Result | Uploaded artifact ID |
| --- | --- | --- | --- |
| Shared Ubuntu test/build gate | `87613532957` | passed in 1m38s | n/a |
| macOS 14 arm64 package/runtime | `87613862755` | passed in 1m48s | `8374539145` |
| Windows Server 2022 x64 package/runtime/install | `87613862744` | passed in 4m49s | `8374612091` |
| Ubuntu 22.04 x64 package/runtime/install | `87613862770` | passed in 3m07s | `8374571697` |

The Windows runner proved that the release Authenticode gate rejects the
unsigned engineering executable as `NotSigned`, then completed the normal
packaged launch and isolated NSIS install/runtime/uninstall checks. The tagged
release workflow additionally requires valid Authenticode signatures on the
installer, unpacked application, installed application, and generated
uninstaller; a valid outer installer alone is insufficient.

This run also closed a macOS cleanup race observed only after a successful
production load and health window: an escalated process group is now sent one
SIGKILL, not a duplicate signal after teardown. The corrected native run loaded
production, remained healthy for 10 seconds, and reported `PASS`. Both exact
Linux AppImage and DEB runtime/install paths also reported `PASS` again.

Commit `421159a` passed the complete native GitHub Actions Desktop workflow
([run 29494688591](https://github.com/teamofsilicons/silicon-interface-web/actions/runs/29494688591)):

| Native job | Job ID | Result | Uploaded artifact ID |
| --- | --- | --- | --- |
| Shared Ubuntu test/build gate | `87608754087` | passed in 1m33s | n/a |
| macOS 14 arm64 package/runtime | `87609067290` | passed in 1m52s | `8373939899` |
| Windows Server 2022 x64 package/runtime/install | `87609067277` | passed in 5m28s | `8374031376` |
| Ubuntu 22.04 x64 package/runtime/install | `87609067283` | passed in 3m03s | `8373969674` |

This run exercised every Linux format users receive. The exact x64 AppImage
was extracted without relying on FUSE, launched under isolated Xvfb/D-Bus/XDG
state, loaded `https://interface.teamofsilicons.com/`, and remained healthy for
10 seconds. The exact DEB was then installed with apt, launched under the same
bounded runtime checks, and removed. Both gates validated that the authenticated
readiness PID resolved to the packaged executable and reported `PASS`.

The same run also reconfirmed the packaged macOS arm64 bundle and both Windows
runtime paths. Windows launched the unpacked candidate, silently installed the
NSIS candidate, launched the executable from that isolated installation, loaded
the production renderer, remained healthy for 10 seconds, and verified that
uninstall removed the application. Artifact upload occurred only after every
host-native runtime gate passed.

Commit `57d07eb` passed the complete native GitHub Actions Desktop workflow
([run 29494174322](https://github.com/teamofsilicons/silicon-interface-web/actions/runs/29494174322)):

| Native job | Job ID | Result | Uploaded artifact ID |
| --- | --- | --- | --- |
| Shared Ubuntu test/build gate | `87607109988` | passed in 1m48s | n/a |
| macOS 14 arm64 package/runtime | `87607466611` | passed in 1m45s | `8373737615` |
| Windows Server 2022 x64 package/runtime/install | `87607466621` | passed in 4m22s | `8373799843` |
| Ubuntu 22.04 x64 package/runtime/install | `87607466609` | passed in 3m02s | `8373768247` |

The Windows job first launched the unpacked candidate, then silently installed
the NSIS candidate, launched the executable from that isolated installation,
and required a second authenticated production-renderer readiness receipt plus
10-second stability window before running and verifying uninstall. Both native
launches loaded `https://interface.teamofsilicons.com/`. This closes the gap
between package assembly evidence and the executable users actually install.

Commit `c3ae6a9` passed the complete native GitHub Actions Desktop workflow
([run 29493558076](https://github.com/teamofsilicons/silicon-interface-web/actions/runs/29493558076)):

| Native job | Job ID | Result | Uploaded artifact ID |
| --- | --- | --- | --- |
| Shared Ubuntu test/build gate | `87605138553` | passed in 1m42s | n/a |
| macOS 14 arm64 package/runtime | `87605481238` | passed in 1m43s | `8373490825` |
| Windows Server 2022 x64 package/runtime/install | `87605481297` | passed in 4m25s | `8373556885` |
| Ubuntu 22.04 x64 package/runtime/install | `87605481248` | passed in 2m31s | `8373511596` |

The app-authored native evidence was successful on every host. macOS and
Windows loaded `https://interface.teamofsilicons.com/` from the packaged main
process and stayed healthy for the 10-second stability window. Windows then
installed version `0.1.0` x64 from the NSIS candidate into an isolated path and
confirmed that its uninstaller removed the application. Ubuntu installed the
exact DEB with apt, proved that the readiness PID resolved to the packaged
executable, stayed healthy for 10 seconds under Xvfb/D-Bus, and confirmed DEB
removal. Artifact upload occurred only after those gates passed.

The pushed tree at commit `2857b38` also passed the full native GitHub Actions
Desktop workflow ([run 29486760897](https://github.com/teamofsilicons/silicon-interface-web/actions/runs/29486760897)):

| Native job | Job ID | Result | Uploaded artifact ID |
| --- | --- | --- | --- |
| Shared Ubuntu test/build gate | `87582982956` | passed in 1m58s | n/a |
| macOS 14 arm64 package | `87583387078` | passed in 2m05s | `8370781556` |
| Windows Server 2022 x64 package | `87583387059` | passed in 3m54s | `8370828250` |
| Ubuntu 22.04 x64 package | `87583387080` | passed in 2m05s | `8370790623` |

The three CI artifacts were downloaded after the run. Their updater metadata
matched the exact candidate names, byte sizes, and SHA-512 digests. The CI DMG,
macOS ZIP, and Windows ZIP passed container integrity checks; the CI Debian
archive had the expected `debian-binary`, control, and data members. The
AppImage was identified as an x86-64 ELF executable, the Windows installer as
an NSIS GUI executable, and the macOS application as an arm64 Mach-O binary.
All three CI binaries had the required fuse policy, and all three CI ASARs had
the same 311-entry allow-list.

This branch build intentionally disables signing-key discovery. Its native
artifacts prove native assembly and package integrity, but remain unsigned
engineering candidates; distributable signatures are enforced by the separate
tagged release workflow.

The reliability suite covers draft journaling and conflict recovery, durable
outbox behavior, held sends, attachment staging/resume, receipts, reconnect and
sync barriers, offline history, notifications, service-worker recovery, and the
desktop bridge.

The current implementation additionally protects Windows shutdown/restart/
sign-out with the same bounded local-durability handshake as an ordinary quit,
sanitizes native Save As names against Windows device names and invalid/path-
budget characters, and preserves every ordered file in a multi-file native
drop instead of retaining only the first item.

The Windows one-click acceptance path uses a pinned deterministic NSIS GUID,
performs the real default per-user install, discovers the directory Windows
registered for that GUID, launches the installed application, and then requires
both the installed executable and registry identity to disappear on uninstall.
It refuses to replace a pre-existing local installation.

## Package evidence

Updater candidates were assembled and their generated metadata was checked
against every artifact's exact file name and SHA-512 digest. Declared metadata
sizes were checked when present; the release manifest independently records and
verifies the exact byte size of every payload:

| Platform candidate | Formats | Metadata | Result |
| --- | --- | --- | --- |
| macOS x64 | DMG + ZIP | `latest-mac.yml` | passed |
| macOS arm64 | DMG + ZIP | `latest-mac.yml` | passed |
| Windows x64 | NSIS EXE + ZIP | `latest.yml` | passed |
| Windows arm64 | full NSIS EXE + ZIP | `latest.yml` | passed |
| Linux x64 | AppImage + DEB | `latest-linux.yml` | passed |
| Linux arm64 | AppImage + DEB | `latest-linux-arm64.yml` | passed |

The current tree also completed a non-native architecture rehearsal for macOS
x64, Windows arm64, and Linux arm64. All updater metadata matched the exact
artifact names, sizes, and SHA-512 values. The x64 DMG checksum was valid and
its ZIP had no compressed-data errors; the Windows ZIP was valid and contained
an Aarch64 PE application; the Linux AppImage and unpacked application were
AArch64 ELF binaries, and the DEB contained valid Debian control/data members.
This rehearsal caught and corrected the vendor-standard Linux arm64 pointer
name (`latest-linux-arm64.yml`) before the signed tag workflow.

Container checks also passed: DMG verification, both ZIP integrity checks, and
the Debian archive structure. The packaged ASAR allow-list was identical across
the three candidates and contained the compiled shell and required updater
runtime only—no Next.js server, TypeScript source, or localhost proxy.

All inspected platform binaries had the required Electron fuses:

- RunAsNode disabled;
- cookie encryption enabled;
- `NODE_OPTIONS` and CLI inspect arguments disabled;
- embedded ASAR validation enabled;
- application code restricted to the ASAR;
- extra `file://` privileges disabled.

The current unpacked macOS arm64 engineering build was prepared after fuse
mutation, ad-hoc signed with the required Electron JIT entitlements, and passed
`codesign --verify`. It launched beside an already-running installed copy using
an isolated profile, received an app-authored readiness receipt only after the
trusted production desktop bridge hydrated, stayed healthy for the bounded
stability window, and left no process, receipt, or profile behind.

Cookie encryption cannot initialize Electron's macOS network service under an
ad-hoc identity because that identity has no stable Developer ID Keychain
group. The engineering helper therefore disables only that fuse and verifies
all remaining production fuses before re-signing. Release mode is non-mutating
and requires cookie encryption plus a timestamped, hardened-runtime Developer
ID Application signature pinned to `APPLE_TEAM_ID`. This exception never
applies to a distributable build.

The branch and tagged workflows now include app-authored native runtime gates:
macOS launches the real packaged bundle; Windows launches and supervises the
unpacked packaged executable, installs the NSIS candidate in an ephemeral
directory, launches that installed executable, and confirms uninstall; Ubuntu
extracts and launches the exact AppImage, then validates and installs the exact
DEB under isolated Xvfb/D-Bus/XDG state, proves each receipt PID resolves to the
packaged executable, and uninstalls the DEB. A process merely staying alive
is insufficient—the receipt must match version, platform, architecture, PID,
timestamp, packaged state, and the exact production HTTPS origin.

The tagged release gate is stricter than branch engineering smoke: it verifies
the stapled Developer ID application inside both DMG and ZIP containers, then
extracts and launches the exact host-native ZIP artifact without mutating its
signature. The Windows release gate likewise launches both the signed unpacked
candidate and the application installed from the signed NSIS executable.

The release rehearsal produced a CycloneDX SBOM with 275 components and a
16-file, 706,677,312-byte manifest whose SHA-256 entries all verified.

Stable-feed publication is payload-first and fail-closed. Every installer,
archive, blockmap, and other versioned payload is uploaded and read-after-write
verified before any `latest*.yml` pointer changes. Existing payload keys are
retained when their stored byte count and SHA-256 metadata match, while a
different body at an existing immutable key aborts the release. Old installers
are never deleted by activation. Mutable pointers and shared summaries use
no-cache headers, are activated last, and are the only CDN paths invalidated.
GitHub assets are likewise staged in a private draft, verified by SHA-256 and
size, and uploaded without overwrite. The draft becomes public only after the
stable feed activates successfully.

## Production integration

The deployed web bundle at `https://interface.teamofsilicons.com` contains the
protocol-v1 desktop lifecycle/deep-link adapter. Glass returned healthy database
and Redis readiness from `/healthz` and `/readyz` during the verification run.

The exact current full Interface working set was promoted through the guarded
candidate/CAS deployment path as Vercel deployment
`dpl_D6qiXcTP8pbLXhRm9xxLJ3bvHf8u`. Its immutable candidate, production alias,
and alias-stability checks passed after 286/286 reliability tests, ESLint,
TypeScript, a local production build, and the mandatory Vercel Node 24 build.
The retained machine-readable evidence is
`/Users/codanium/.silicon/releases/interface-20260716T185727Z-bbcc06f58495/deployment-evidence.json`.

The AWS release foundation is deployed as stack
`silicon-interface-desktop-releases` in account `234951665042`, `us-east-1`:

| Control | Verified state |
| --- | --- |
| Release bucket | private, public access fully blocked |
| Stored artifacts | AES-256 encrypted and versioned |
| CloudFront | deployed, HTTP/2+3, signed S3 Origin Access Control |
| GitHub authentication | short-lived OIDC; no AWS access key |
| OIDC trust | this repository's `desktop-v*` tags only |
| Publish scope | `interface/stable/*` only; outside write simulation denied |
| CDN permission | invalidation for distribution `E6OSPAJ24EU2D` only |
| CloudFront origin endpoint | `https://d2fexyeajugqns.cloudfront.net` |
| Public release endpoint | `https://downloads.teamofsilicons.com` |
| Public TLS | ACM `ISSUED`; alias attached; Amazon RSA 2048 certificate |

GitHub variables `AWS_RELEASE_ROLE_ARN`, `AWS_RELEASE_BUCKET`, and
`AWS_RELEASE_CLOUDFRONT_DISTRIBUTION_ID` are configured. Release provenance is
mandatory: every payload is attested through GitHub's Sigstore-backed
attestation service before the GitHub draft or stable feed can publish. The
release workflow's third-party actions are pinned to immutable commit SHAs.

The manual macOS signing preflight at GitHub Actions run
`29507864074` passed on the host-native arm64 candidate in 4m48s. It imported
the encrypted Developer ID archive, selected the pinned
`Developer ID Application: Shubham Gupta (LTBSK59BJ2)` identity, signed with
hardened runtime and a secure timestamp, received Apple notarization, verified
the stapled ticket and Gatekeeper assessment on the unpacked application plus
the DMG and ZIP contents, verified update metadata, launched the exact signed
ZIP application without mutating it, received the authenticated production
readiness receipt, and uploaded the preflight evidence. The workflow publishes
nothing and is safe to repeat before a tag.

The replacement Developer ID archive and updated export password were proven
again by
[run 29512015715](https://github.com/teamofsilicons/silicon-interface-web/actions/runs/29512015715)
at commit `dd5ba18`. The 4m30s run passed certificate import, Developer ID
selection, hardened-runtime signing, Apple notarization, stapling, Gatekeeper
assessment in the app/DMG/ZIP, updater metadata verification, exact signed ZIP
launch, and artifact upload (`8381150742`). This is the currently configured
GitHub certificate archive, not a superseded local export.

The final dual-architecture signing preflight at commit `dab249f`
([run 29517673706](https://github.com/teamofsilicons/silicon-interface-web/actions/runs/29517673706))
passed on both native Apple Silicon and native Intel runners. The arm64 job
`87686674678` and x64 job `87686674680` each imported the same protected
Developer ID archive, signed with hardened runtime and timestamp, notarized,
verified the stapled app/DMG/ZIP plus Gatekeeper, launched the exact signed ZIP
application against production, and uploaded architecture-scoped evidence
artifacts `8383440794` and `8383547634`.

Artifact `8382689613` from the prior exact-certificate arm64 preflight was also
downloaded to the local Apple Silicon Mac, its DMG checksum verified, mounted
read-only, copied to an isolated Applications directory, and re-checked with
`codesign`, `stapler`, and Gatekeeper. The copied application then reported the
exact production renderer and remained healthy for the ten-second native
stability window. No system Gatekeeper bypass or user profile was used.

## External gates before a public stable release

These are not source defects and cannot be silently bypassed:

1. Complete CA identity validation and provide the credentials for a trusted
   Windows signing identity. The SSL.com eSigner cloud-HSM adapter is integrated
   and locally passed its fail-closed unit/config-resolution gates; it pins and
   verifies CodeSignTool v1.3.2, accepts only SHA-256, redacts credentials,
   requires the exact CA-verified publisher in the updater configuration, and
   is followed by native signer/timestamp/publisher verification. No certificate
   has yet been issued for the desired Windows publisher.
2. Complete the interactive acceptance slice in `desktop/README.md` on clean
   physical Windows, macOS, and Linux machines. CI now covers deterministic
   package/runtime readiness; it cannot click native dialogs, test IME/screen
   readers, or replace a signed human install acceptance.
3. Commit the release tree, push `desktop-v0.1.0`, and require every native
   signing/package/publish job to finish green before distributing an installer.

Until those gates are complete, local packages are engineering candidates only.
No user should be instructed to bypass Gatekeeper, SmartScreen, or Linux package
verification.
