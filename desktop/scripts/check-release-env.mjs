const platform = process.argv[2];
let provider;
let required = [];

if (platform === "mac") {
  required = ["CSC_LINK", "CSC_KEY_PASSWORD", "APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD", "APPLE_TEAM_ID"];
} else if (platform === "win") {
  provider = process.env.WINDOWS_SIGNING_PROVIDER?.trim() || "pfx";
  if (provider === "pfx") {
    required = ["WIN_CSC_LINK", "WIN_CSC_KEY_PASSWORD"];
  } else if (provider === "sslcom-esigner") {
    required = [
      "SSL_CODE_SIGN_JAR",
      "SSL_ESIGNER_USERNAME",
      "SSL_ESIGNER_PASSWORD",
      "SSL_ESIGNER_CREDENTIAL_ID",
      "SSL_ESIGNER_TOTP_SECRET",
    ];
  } else {
    console.error(`check-release-env: unsupported Windows signing provider ${provider}`);
    process.exit(1);
  }
}

if (required.length === 0) {
  console.error("check-release-env: expected 'mac' or 'win'");
  process.exit(1);
}
const missing = required.filter((name) => !process.env[name]?.trim());
if (missing.length > 0) {
  console.error(`check-release-env: missing ${missing.join(", ")}`);
  process.exit(1);
}
console.log(`check-release-env: ${platform}${provider ? `/${provider}` : ""} signing configuration is present`);
