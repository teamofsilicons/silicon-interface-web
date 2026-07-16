#!/usr/bin/env bash
set -euo pipefail

PROFILE="${AWS_PROFILE:-silicon-production}"
REGION="${AWS_REGION:-us-east-1}"
DOMAIN="${RELEASE_DOMAIN:-downloads.teamofsilicons.com}"
STACK="${RELEASE_STACK:-silicon-interface-desktop-releases}"
REPOSITORY="${GITHUB_REPOSITORY:-teamofsilicons/silicon-interface-web}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ "$REGION" != "us-east-1" ]]; then
  echo "Desktop CloudFront certificates must be provisioned in us-east-1." >&2
  exit 1
fi

ACCOUNT_ID="$(aws --profile "$PROFILE" sts get-caller-identity --query Account --output text)"
if [[ "$ACCOUNT_ID" != "234951665042" ]]; then
  echo "Refusing to deploy to unexpected AWS account $ACCOUNT_ID." >&2
  exit 1
fi

CERTIFICATE_ARN="$(
  aws --profile "$PROFILE" acm list-certificates --region "$REGION" \
    --query "CertificateSummaryList[?DomainName=='$DOMAIN'] | [0].CertificateArn" \
    --output text
)"
if [[ -z "$CERTIFICATE_ARN" || "$CERTIFICATE_ARN" == "None" ]]; then
  CERTIFICATE_ARN="$(
    aws --profile "$PROFILE" acm request-certificate --region "$REGION" \
      --domain-name "$DOMAIN" --validation-method DNS --key-algorithm RSA_2048 \
      --options CertificateTransparencyLoggingPreference=ENABLED \
      --tags Key=Product,Value=SiliconInterface Key=Purpose,Value=DesktopReleases \
      --query CertificateArn --output text
  )"
fi

STATUS="$(
  aws --profile "$PROFILE" acm describe-certificate --region "$REGION" \
    --certificate-arn "$CERTIFICATE_ARN" --query Certificate.Status --output text
)"
STACK_CERTIFICATE_ARN="$CERTIFICATE_ARN"
if [[ "$STATUS" != "ISSUED" ]]; then
  STACK_CERTIFICATE_ARN=""
fi

OWNER="${REPOSITORY%%/*}"
REPO="${REPOSITORY#*/}"
OWNER_ID="$(gh api "orgs/$OWNER" --jq .id)"
REPO_ID="$(gh api "repos/$REPOSITORY" --jq .id)"

aws --profile "$PROFILE" cloudformation deploy --region "$REGION" \
  --stack-name "$STACK" \
  --template-file "$SCRIPT_DIR/release-foundation.yml" \
  --capabilities CAPABILITY_NAMED_IAM \
  --no-fail-on-empty-changeset \
  --parameter-overrides \
    CertificateArn="$STACK_CERTIFICATE_ARN" \
    ReleaseDomain="$DOMAIN" \
    GitHubOwner="$OWNER" \
    GitHubOwnerId="$OWNER_ID" \
    GitHubRepository="$REPO" \
    GitHubRepositoryId="$REPO_ID"

output() {
  aws --profile "$PROFILE" cloudformation describe-stacks --region "$REGION" \
    --stack-name "$STACK" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue | [0]" --output text
}

ROLE_ARN="$(output GitHubReleaseRoleArn)"
BUCKET="$(output BucketName)"
DISTRIBUTION_ID="$(output DistributionId)"
DISTRIBUTION_DOMAIN="$(output DistributionDomainName)"
RELEASE_ENDPOINT="$(output ReleaseEndpoint)"

gh variable set AWS_RELEASE_ROLE_ARN --repo "$REPOSITORY" --body "$ROLE_ARN"
gh variable set AWS_RELEASE_BUCKET --repo "$REPOSITORY" --body "$BUCKET"
gh variable set AWS_RELEASE_CLOUDFRONT_DISTRIBUTION_ID \
  --repo "$REPOSITORY" --body "$DISTRIBUTION_ID"
gh variable set ENABLE_GITHUB_ATTESTATIONS --repo "$REPOSITORY" --body "true"

echo "Release foundation ready."
echo "Bucket: $BUCKET"
echo "CloudFront: $DISTRIBUTION_DOMAIN"
echo "GitHub role: $ROLE_ARN"
echo "Release endpoint: $RELEASE_ENDPOINT"

if [[ "$STATUS" == "ISSUED" ]]; then
  echo "Namecheap CNAME: downloads -> $DISTRIBUTION_DOMAIN"
else
  echo
  echo "The AWS certificate is pending DNS validation. Add this Namecheap CNAME:"
  aws --profile "$PROFILE" acm describe-certificate --region "$REGION" \
    --certificate-arn "$CERTIFICATE_ARN" \
    --query 'Certificate.DomainValidationOptions[0].ResourceRecord.{Name:Name,Type:Type,Value:Value}' \
    --output table
  echo "Then rerun this script to attach downloads.teamofsilicons.com to CloudFront."
fi
