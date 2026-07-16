const platform = process.argv[2];
const required = platform === "mac"
  ? ["CSC_LINK", "CSC_KEY_PASSWORD", "APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD", "APPLE_TEAM_ID"]
  : platform === "win"
    ? ["WIN_CSC_LINK", "WIN_CSC_KEY_PASSWORD"]
    : [];

if (required.length === 0) {
  console.error("check-release-env: expected 'mac' or 'win'");
  process.exit(1);
}
const missing = required.filter((name) => !process.env[name]?.trim());
if (missing.length > 0) {
  console.error(`check-release-env: missing ${missing.join(", ")}`);
  process.exit(1);
}
console.log(`check-release-env: ${platform} signing configuration is present`);
