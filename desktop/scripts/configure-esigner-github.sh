#!/usr/bin/env bash
set -euo pipefail

repository="teamofsilicons/silicon-interface-web"
publisher_name=""
mode="configure"

usage() {
  cat <<'EOF'
Usage:
  configure-esigner-github.sh --publisher-name "Exact certificate Common Name" [--repo OWNER/REPO]
  configure-esigner-github.sh --publisher-name "Exact certificate Common Name" [--repo OWNER/REPO] --check

Configure mode asks GitHub CLI to prompt securely for each eSigner secret. The
values are encrypted by GitHub CLI and are never written to a local file or
passed as command-line arguments. Variables are activated only after every
secret prompt succeeds.

Check mode is read-only. It verifies that the required secret names exist and
that the provider and publisher variables exactly match the supplied value.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --publisher-name)
      [[ $# -ge 2 ]] || { echo "Missing value for --publisher-name" >&2; exit 2; }
      publisher_name="$2"
      shift 2
      ;;
    --repo)
      [[ $# -ge 2 ]] || { echo "Missing value for --repo" >&2; exit 2; }
      repository="$2"
      shift 2
      ;;
    --check)
      mode="check"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ -z "$publisher_name" ]]; then
  echo "--publisher-name is required" >&2
  exit 2
fi
if [[ "$publisher_name" =~ ^[[:space:]] || "$publisher_name" =~ [[:space:]]$ || "$publisher_name" =~ [[:cntrl:]] ]]; then
  echo "Publisher name must be the exact single-line certificate Common Name without surrounding whitespace" >&2
  exit 2
fi
if [[ ! "$repository" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]; then
  echo "--repo must be OWNER/REPO" >&2
  exit 2
fi

command -v gh >/dev/null 2>&1 || { echo "GitHub CLI (gh) is required" >&2; exit 1; }
gh auth status >/dev/null

required_secrets=(
  SSL_ESIGNER_USERNAME
  SSL_ESIGNER_PASSWORD
  SSL_ESIGNER_CREDENTIAL_ID
  SSL_ESIGNER_TOTP_SECRET
)

check_configuration() {
  local secret_names provider actual_publisher secret_name
  secret_names="$(gh secret list --repo "$repository" --app actions --json name --jq '.[].name')"
  for secret_name in "${required_secrets[@]}"; do
    if ! printf '%s\n' "$secret_names" | grep -Fqx "$secret_name"; then
      echo "Missing encrypted Actions secret: $secret_name" >&2
      return 1
    fi
  done

  provider="$(gh variable list --repo "$repository" --json name,value --jq '.[] | select(.name == "WINDOWS_SIGNING_PROVIDER") | .value')"
  actual_publisher="$(gh variable list --repo "$repository" --json name,value --jq '.[] | select(.name == "WINDOWS_PUBLISHER_NAME") | .value')"
  if [[ "$provider" != "sslcom-esigner" ]]; then
    echo "WINDOWS_SIGNING_PROVIDER is not exactly sslcom-esigner" >&2
    return 1
  fi
  if [[ "$actual_publisher" != "$publisher_name" ]]; then
    echo "WINDOWS_PUBLISHER_NAME does not exactly match the certificate Common Name" >&2
    return 1
  fi
  echo "eSigner GitHub configuration: PASS ($repository, publisher: $publisher_name)"
}

if [[ "$mode" == "check" ]]; then
  check_configuration
  exit 0
fi

if [[ ! -t 0 || ! -t 1 ]]; then
  echo "Configure mode requires an interactive terminal; use --check for automation" >&2
  exit 1
fi

echo "Configuring SSL.com eSigner for $repository"
echo "GitHub CLI will securely prompt for each value. Do not paste a one-time OTP."
for secret_name in "${required_secrets[@]}"; do
  echo
  echo "Set $secret_name:"
  gh secret set "$secret_name" --repo "$repository" --app actions
done

# Feed public configuration through standard input as well, so punctuation in
# the verified X.509 name cannot be reinterpreted by a shell or copied wrongly.
printf '%s' "sslcom-esigner" | gh variable set WINDOWS_SIGNING_PROVIDER --repo "$repository"
printf '%s' "$publisher_name" | gh variable set WINDOWS_PUBLISHER_NAME --repo "$repository"

check_configuration
echo "Next: dispatch Desktop signing preflight with platform=windows."
