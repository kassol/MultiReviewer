# MultiReviewer

Agent-driven, multi-model code review for self-hosted Gitea.

Real coding agents review each pull request. Each reviewer runs on a full working copy of the repository, so it can open files, follow call chains, and read code outside the diff. Multiple models review in parallel; their findings are deduplicated and published as one review with line-level comments. Reviews converge instead of piling up: resolve a comment on the platform, and later runs fold it away until the code it points at changes.

## Requirements

**Gitea 1.26.0 or later (Enterprise: 26.0.0 or later).** Disposition tracking is built on the resolve / unresolve endpoints for review comments, which exist only from these versions. The service checks the instance version at startup and refuses to run on older instances.

A GitHub adapter exists for development and testing, but repository admission is Gitea-only: only registered Gitea repositories are reviewed.

## How it works

- A webhook fires on pull request open and on new commits. The service clones the repository server-side and checks out the head commit.
- Each configured model reviews the change in its own read-only subprocess, holding only its own vendor credentials.
- Findings from all models are merged, deduplicated, and published as one non-blocking review. The review never blocks the merge — the author keeps the final say.
- Findings resolved on the platform stay hidden in later runs while the code they point at is unchanged. Disposition data accumulates per model and per category, so you can measure which models earn their keep.
- Repositories are onboarded through a management panel, which also shows run history, manual re-runs, and disposition statistics. Webhooks and their secrets are created and rotated by the panel, never by hand.

## Deployment

The deployment unit is a Docker image. The server needs three files in one directory — `docker-compose.yml`, `setup.sh`, and the files the wizard writes — and no source code.

```bash
# Dev machine: build the image and push it to your registry
scripts/build-push.sh registry.example.com/team/multireviewer:latest

# Server: first deployment — the wizard asks for credentials,
# starts the container, and verifies a real panel login
bash setup.sh

# Server: updates
docker compose pull && docker compose up -d
```

The full deployment reference — environment variables, Gitea preparation steps, bot account scopes — is in [AGENTS.md](AGENTS.md) under “部署”.

## Documentation

- [AGENTS.md](AGENTS.md) — project overview, commands, deployment reference.
- [CONTEXT.md](CONTEXT.md) — domain glossary; code and docs use these terms.
- [docs/adr/](docs/adr/) — architecture decision records.
