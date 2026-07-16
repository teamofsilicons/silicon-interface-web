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
| Desktop TypeScript + policy/release tests | 14/14 passed |
| Interface TypeScript | passed |
| Chat reliability suite | 249/249 passed |
| Next.js 16.2.6 production webpack build | passed; 14 routes generated |
| Workflow YAML parse | passed |
| CloudFormation template validation | passed in `us-east-1` |

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

## Package evidence

Updater candidates were assembled and their generated metadata was checked
against every artifact's exact file name, byte size, and SHA-512 digest:

| Platform candidate | Formats | Metadata | Result |
| --- | --- | --- | --- |
| macOS arm64 | DMG + ZIP | `latest-mac.yml` | passed |
| Windows x64 | NSIS EXE + ZIP | `latest.yml` | passed |
| Linux x64 | AppImage + DEB | `latest-linux.yml` | passed |

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

The unpacked macOS arm64 engineering build was ad-hoc signed after fuse mutation,
passed `codesign --verify`, launched the sandboxed renderer against production,
maintained TLS connections, and exited cleanly. This proves the local runtime
path; an ad-hoc signature is not a distributable signature.

The release rehearsal produced a CycloneDX SBOM with 275 components and a
16-file, 706,677,312-byte manifest whose SHA-256 entries all verified.

## Production integration

The deployed web bundle at `https://interface.teamofsilicons.com` contains the
protocol-v1 desktop lifecycle/deep-link adapter. Glass returned healthy database
and Redis readiness from `/healthz` and `/readyz` during the verification run.

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
| Current endpoint | `https://d2fexyeajugqns.cloudfront.net` |

GitHub variables `AWS_RELEASE_ROLE_ARN`, `AWS_RELEASE_BUCKET`,
`AWS_RELEASE_CLOUDFRONT_DISTRIBUTION_ID`, and
`ENABLE_GITHUB_ATTESTATIONS` are configured. The release workflow's third-party
actions are pinned to immutable commit SHAs.

## External gates before a public stable release

These are not source defects and cannot be silently bypassed:

1. Add the ACM validation CNAME at Namecheap:
   - host: `_8437dc4d5da0d39e9e28dfafd6bac595.downloads`
   - value: `_4faf8f40c16340d1d472878859fa374e.jkddzztszm.acm-validations.aws.`
2. After ACM becomes `ISSUED`, rerun
   `AWS_PROFILE=silicon-production desktop/infra/deploy-release-foundation.sh`,
   then add `downloads` as a CNAME to `d2fexyeajugqns.cloudfront.net`.
3. Supply Apple Developer ID/notarization secrets and a trusted Windows signing
   certificate in GitHub Actions.
4. Run the acceptance slice in `desktop/README.md` on clean physical or hosted
   Windows and Linux machines. Cross-compilation is evidence, not an install test.
5. Commit the release tree, push `desktop-v0.1.0`, and require every native
   signing/package/publish job to finish green before distributing an installer.

Until those gates are complete, local packages are engineering candidates only.
No user should be instructed to bypass Gatekeeper, SmartScreen, or Linux package
verification.
