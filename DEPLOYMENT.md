# Production deployment

The frontend has one production deploy command. Run it from this repository:

```bash
bash scripts/deploy-production.sh --confirm-production
```

It deploys the exact current working tree—including modified and nonignored
untracked files—to `interface.teamofsilicons.com`. A clean Git commit is not
required, because the script creates a deterministic, content-addressed source
archive first and deploys that frozen archive rather than the mutable checkout.

Before a real deployment, run the complete local preflight without changing Vercel:

```bash
bash scripts/deploy-production.sh --dry-run
```

## What the command guarantees

The script fails closed and performs these steps in order:

1. Confirms the local Vercel link is the approved `silicon-interface` project.
2. Acquires a deploy lock so two releases cannot run simultaneously.
3. Freezes tracked edits, tracked deletions, and nonignored untracked files into
   a deterministic archive. Git-ignored secrets, dependencies, and build output
   are not included.
4. Embeds and records a SHA-256 source manifest, then scans the frozen source for
   credential-like files and high-risk secret signatures.
5. Freezes the source a second time and requires byte-identical output.
6. Installs from the lockfile and runs the reliability suite, ESLint, TypeScript,
   and a local optimized production build against the frozen tree.
7. Uses Vercel CLI to create a production-target deployment with
   `--skip-domain`, so the candidate cannot replace the public app before it is
   verified.
8. Hard-binds the web bundle to `https://glass.teamofsilicons.com` /
   `wss://glass.teamofsilicons.com`, requires the immutable candidate to be
   `READY` from the expected project, and passes an authenticated HTTP/security
   header smoke test.
9. Rechecks that no concurrent release changed the domain, promotes that exact
   deployment ID, watches the custom domain for alias races,
   and verifies the public app again.
10. If anything fails after promotion, restores the deployment that owned the
    production alias before the release began—but only while the alias still
    points to this script's candidate. A concurrent deployment is never
    overwritten.

Every run writes private artifacts under `~/.silicon/releases/<release-id>/`:

- `source.tar.gz`: immutable deploy source
- `source-manifest.json`: per-file hashes and source identity
- `deployment-evidence.json`: gates, deployment ID, alias proof, and outcome
- `immutable-smoke-headers.txt` and `public-smoke-headers.txt`: HTTP evidence

The command never reads `.env.local` or `.vercel/.env.production.local` into the
archive. Vercel supplies production environment variables from the linked
project. Do not replace this workflow with a direct `vercel --prod` command.

## Prerequisites

- Node.js 24 recommended (a different local major is recorded as a parity
  warning), pnpm 10.33.0, Python 3, Git, tar, and curl
- An authenticated Vercel CLI session with access to the
  `saketdev12-5675s-projects` team
- This checkout linked to project `prj_r0fx5aWniIim4fitY5UNbkAHVrRo`

Run the focused deploy-tool tests with:

```bash
pnpm test:deploy
```
