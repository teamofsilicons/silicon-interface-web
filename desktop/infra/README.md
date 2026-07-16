# Desktop release foundation

This directory defines the paid production release path for the macOS, Windows,
and Linux applications. The CloudFormation stack creates:

- a private, encrypted, versioned S3 bucket with public access blocked;
- CloudFront with signed Origin Access Control reads and TLS 1.2+;
- 30-second cache pointers for mutable update metadata and long caching for
  versioned installers;
- a GitHub OIDC provider and tag-only publishing role scoped to
  `teamofsilicons/silicon-interface-web` and the bucket's
  `interface/stable/*` prefix;
- GitHub Actions variables for the role, bucket, distribution, and provenance.

Run from the Interface repository root:

```bash
AWS_PROFILE=silicon-production desktop/infra/deploy-release-foundation.sh
```

The first run requests the ACM certificate and prints one DNS validation CNAME.
While the certificate is pending, it still creates the bucket, CloudFront
distribution, GitHub OIDC provider, and scoped release role on the CloudFront
hostname. Add the validation record in Namecheap, wait for ACM to issue, then
rerun to attach `downloads.teamofsilicons.com`. After that update finishes, add
the printed `downloads` CNAME in Namecheap. The script is idempotent and refuses
to deploy outside AWS account `234951665042`.

The stack retains the bucket on deletion, so an accidental stack removal cannot
erase signed installers or update history. CloudFormation does not store AWS
access keys; GitHub obtains a short-lived session only from a matching
`desktop-v*` tag identity.
