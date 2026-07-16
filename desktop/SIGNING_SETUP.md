# Desktop signing setup

This is the one-time acquisition and secret-handoff guide for public Silicon
Interface desktop releases. Never commit a private key, certificate archive,
app-specific password, cloud-signing credential, or decoded secret.

## macOS: Developer ID and notarization

Silicon Interface is distributed directly as a DMG and ZIP. It therefore needs
a **Developer ID Application** certificate and Apple notarization. It does not
need a Developer ID Installer certificate because the project does not publish
Apple `.pkg` installers.

The `Apple Distribution` and `Apple Development` identities already present on
the development Mac are not substitutes for Developer ID Application. Apple
documents the direct-distribution certificate flow at
<https://developer.apple.com/help/account/certificates/create-developer-id-certificates/>.

### 1. Confirm the Apple team

1. Sign in at <https://developer.apple.com/account/>.
2. Open **Membership details** and record the exact Team ID.
3. Confirm that the membership is active.
4. Sign in as the **Account Holder**. Apple currently restricts manually
   created Developer ID certificates to the Account Holder.

If no active membership exists, enroll in the Apple Developer Program at
<https://developer.apple.com/programs/enroll/>. Organization enrollment needs
the legal entity name, D-U-N-S number, binding authority, domain email, and a
public company website. Individual enrollment displays the person's legal name
as the developer identity.

### 2. Create the certificate signing request on the Mac

1. Open **Keychain Access** from `/Applications/Utilities`.
2. Choose **Keychain Access → Certificate Assistant → Request a Certificate
   from a Certificate Authority**.
3. Enter the Apple Developer account email.
4. Use a descriptive Common Name such as `Team of Silicons Developer ID 2026`.
5. Leave **CA Email Address** empty.
6. Select **Saved to disk** and save the `.certSigningRequest` file outside the
   repository.

Apple's CSR instructions are at
<https://developer.apple.com/help/account/certificates/create-a-certificate-signing-request>.

### 3. Issue and install Developer ID Application

1. In **Certificates, Identifiers & Profiles**, open **Certificates** and click
   **+**.
2. Under **Software**, choose **Developer ID**.
3. Select **Developer ID Application**.
4. Upload the CSR, create the certificate, and download the `.cer` file.
5. Double-click the `.cer` file to install it in the login keychain.
6. In Keychain Access → **My Certificates**, expand the new Developer ID entry
   and verify that a private key appears beneath it.

Do not revoke another Developer ID certificate unless its owner and release
history are known. Apple permits multiple active Developer ID certificates.

### 4. Export a CI certificate archive

1. In Keychain Access → **My Certificates**, select the complete Developer ID
   Application entry, including its private key.
2. Choose **File → Export Items** and export a password-protected `.p12`.
3. Generate a unique high-entropy export password.
4. Store the `.p12` and its password in the team's password manager. Do not
   place either in the repository, Downloads CDN, Drive link, email, or chat.

Before leaving Keychain Access, verify that the selected/exported row is exactly
`Developer ID Application: Shubham Gupta (LTBSK59BJ2)`. The non–Mac App Store
build pins the `Shubham Gupta (LTBSK59BJ2)` subject/team qualifier while
electron-builder pins the required Developer ID Application certificate type;
Apple Development and Apple Distribution archives are therefore rejected.

The release workflow consumes the base64 form of that `.p12` as
`MACOS_CSC_LINK` and its export password as `MACOS_CSC_KEY_PASSWORD`.

### 5. Create notarization credentials

1. Ensure two-factor authentication is enabled for the Apple Account.
2. Sign in at <https://account.apple.com/>.
3. Open **Sign-In and Security → App-Specific Passwords**.
4. Generate one named `Silicon Interface GitHub notarization`.

Use the Apple Account email as `APPLE_ID`, the generated password as
`APPLE_APP_SPECIFIC_PASSWORD`, and the Membership details Team ID as
`APPLE_TEAM_ID`. Apple explains app-specific passwords at
<https://support.apple.com/102654>.

### 6. Add the five GitHub Actions secrets

Open the repository's **Settings → Secrets and variables → Actions → New
repository secret** and add:

| Secret | Value |
| --- | --- |
| `MACOS_CSC_LINK` | Single-line base64 encoding of the `.p12` |
| `MACOS_CSC_KEY_PASSWORD` | `.p12` export password |
| `APPLE_ID` | Apple Account email |
| `APPLE_APP_SPECIFIC_PASSWORD` | Dedicated app-specific password |
| `APPLE_TEAM_ID` | Exact Team ID from Membership details |

On macOS, create the single-line base64 value without writing another plaintext
file:

```bash
base64 -i /secure/path/developer-id-application.p12 | tr -d '\n'
```

Paste only into GitHub's encrypted secret form. Never paste any of these values
into an issue, commit, workflow log, terminal command argument, or chat.

## Windows: choose a CI-compatible public-trust signer

Publicly trusted Windows code-signing keys issued since June 2023 must remain in
approved hardware or a cloud HSM. An ordinary exportable `.pfx` is therefore not
the default modern acquisition path. The current CA/B Forum requirements are at
<https://cabforum.org/working-groups/code-signing/requirements/>.

Use one of these paths:

| Situation | Recommended path |
| --- | --- |
| Legal entity in the US, Canada, EU, or UK | Microsoft Azure Artifact Signing Basic |
| Individual developer in the US or Canada | Microsoft Azure Artifact Signing Basic |
| Entity or individual outside those public-trust regions | A CA cloud-HSM service such as SSL.com eSigner or DigiCert KeyLocker |
| Physical USB token | Only with a secured self-hosted Windows runner; not recommended for this GitHub-hosted pipeline |

Do not purchase a USB-only product for the current GitHub-hosted workflow.

### Path A: Azure Artifact Signing

Microsoft currently limits Public Trust identity validation to organizations in
the US, Canada, EU, and UK, and individual developers in the US and Canada.
Confirm eligibility in Microsoft's current quickstart before creating a paid
resource: <https://learn.microsoft.com/azure/artifact-signing/quickstart>.

1. Create or select a paid Azure subscription and Microsoft Entra tenant.
2. Register the `Microsoft.CodeSigning` resource provider.
3. Create an **Artifact Signing** account using the **Basic** SKU.
4. Assign the operator the **Artifact Signing Identity Verifier** role.
5. Submit a **Public** organization or individual identity validation request.
6. After approval, create a **Public Trust** certificate profile.
7. Create a CI service principal and assign it **Artifact Signing Certificate
   Profile Signer** on the certificate profile.
8. Record the tenant ID, client ID, client credential, account name, certificate
   profile name, service endpoint, and exact verified certificate Common Name.

Do not add Azure secrets yet. Once those non-secret account/profile values are
known, adapt `electron-builder.yml` to `win.azureSignOptions` and the release
workflow to Azure authentication, then add only the resulting encrypted GitHub
secrets. Electron-builder's integration is documented at
<https://www.electron.build/docs/features/code-signing/code-signing-win/>.

### Path B: globally available CA cloud signing

For an entity outside Azure Artifact Signing's current public-trust regions,
purchase a code-signing certificate with a **cloud HSM / automated CI signing**
option. SSL.com eSigner and DigiCert KeyLocker both document GitHub Actions
integration:

- <https://www.ssl.com/products/software-integrity/signing-service/>
- <https://docs.digicert.com/zf/digicert-keylocker/ci-cd-integrations-and-deployment-pipelines/plugins/github/binary-signing-using-github-actions.html>

Choose the validation identity deliberately:

- **OV** displays the verified legal organization as the Windows publisher.
- **IV** displays the verified individual and is appropriate only when no legal
  organization identity should appear.
- **EV** is the higher-assurance option when immediate SmartScreen reputation is
  important, but it normally costs more.

At checkout, explicitly select cloud signing / eSigner / KeyLocker rather than
a shipped USB token. Complete the CA's legal identity, phone/address, domain,
and authorization checks. When the service is active, retain its service
credentials only in GitHub Actions secrets and the password manager.

The existing `WINDOWS_CSC_LINK`/`WINDOWS_CSC_KEY_PASSWORD` workflow is retained
only for a CA delivery method that is both CA/B-compliant and usable by a hosted
runner. A cloud-provider purchase normally requires a provider-specific signing
adapter instead; implement and natively verify that adapter before tagging a
release.

## Release acceptance after credentials exist

Before creating a release tag, run the manual **Desktop signing preflight**
workflow. It builds one macOS x64 candidate, signs and notarizes it, validates the
stapled ticket and Gatekeeper assessment in the app, DMG, and ZIP, and launches
the signed ZIP application. It never publishes a release or writes to the
downloads bucket.

1. Confirm all configured secret names exist without printing their values.
2. Run the tagged release workflow for `desktop-v0.1.0`.
3. Require signed macOS x64/arm64, Windows x64/arm64, and Linux x64/arm64 jobs to
   pass before publication.
4. Require Developer ID signature validation, Apple notarization/stapling,
   Gatekeeper assessment, Authenticode validation of the installer and both
   unpacked/installed executables, and the native runtime gates.
5. Verify a downloaded artifact against `SHA256SUMS.txt` and perform the short
   clean-machine acceptance slice in `README.md`.

Never distribute a candidate from a failed or cancelled release workflow, and
never instruct users to bypass Gatekeeper or SmartScreen.
