# Contributing to M4TR1X

Welcome. M4TR1X is a small project with a strong vision and a finite founder bandwidth. Quality contributions move the project; quantity does not. This document is how we keep that ratio sane.

## Before you start

1. **Read the [ARCHITECTURE](docs/ARCHITECTURE.md) and [TOKENOMICS](docs/TOKENOMICS.md) documents first.** Many "bugs" are actually deliberate design choices. Knowing why before suggesting fixes saves everyone time.
2. **Check existing issues.** Search for your idea before opening a new one. Duplicates get closed without comment.
3. **Talk before coding for anything large.** Open an issue describing the problem and proposed approach. Wait for green light before writing 500 lines we may not merge.

## How to file a bug

Open an issue with the `bug` label. Include:

- M4TR1X version (`Settings → About` or `package.json`)
- OS and version (Windows 11 24H2, macOS Sonoma 14.4, Ubuntu 24.04, etc.)
- Reproduction steps — exact, numbered, no "and stuff happens"
- Expected vs actual behavior
- Logs from `~/.m4tr1x/` (Linux/macOS) or `%APPDATA%\m4tr1x\` (Windows) if available

## How to propose a feature

Open an issue with the `enhancement` label. Frame it as: *user need → constraint → proposed solution*. If the proposal contradicts the privacy-first or decentralization principles, expect a polite no with reasoning.

## Pull requests

### Branching

- Branch from `main`.
- Name branches `fix/short-description`, `feat/short-description`, `docs/short-description`.
- One logical change per PR. A PR with three unrelated fixes will be asked to split.

### Coding style

- **JavaScript:** existing code uses 2-space indentation, single quotes, no semicolons except where required, trailing commas where ES allows. Match the file you're editing rather than imposing your own style.
- **Comments:** English in all new code. Existing Italian comments stay until that file is touched for other reasons.
- **Naming:** camelCase functions, snake_case SQLite columns, SCREAMING_SNAKE constants.
- **Errors:** every async function has a try/catch at its API boundary. No silent failures.
- **Logs:** prefix with module name in brackets, e.g. `console.log('[H8] Wallet unlocked')`. No production-side `console.debug`.

### Testing

- Run `npm run test:smoke` before pushing. It must stay green.
- New features that touch the H8 ledger must add an assertion to `scripts/smoke-test.js`.
- New endpoints must be testable with a single curl command in the PR description.

### Commit messages

Conventional commits format:

```
<type>: <subject>

<body — what and why, not how>
```

Types: `feat`, `fix`, `docs`, `refactor`, `test`, `security`, `release`.

Subject under 70 chars. Body wrapped at 80. Reference issues with `Closes #123` or `Refs #123`.

### Review process

- Maintainer (currently solo: @H8dboy) reviews within 7 days.
- Reviews focus on: correctness, security, alignment with project vision, test coverage. Style nits are noted but rarely blocking.
- Approved PRs are merged via squash. Your commits are preserved in the squash commit body.

## Good first issues

Look for the `good-first-issue` label. These are scoped, well-defined, and a maintainer is available to answer questions. Typical scope: 50-200 lines, 1-3 files, no architectural decisions required.

## What we won't merge

- Anything that adds telemetry, analytics, or "phone home" behavior without explicit user opt-in
- Anything that introduces a third-party SaaS dependency on the critical path
- Anything that breaks Tor compatibility
- Anything labeled "AI-generated" without human review and testing
- Reformatting passes that touch hundreds of files for style alone

## License

By contributing you agree your contributions are licensed under MIT, the same as the project.

## Communication

- **GitHub Issues** for bugs and feature requests.
- **GitHub Discussions** for open questions and design debates.
- **Nostr** at the project npub (see README) for announcements.
- No Discord, no Telegram, no Slack. Asynchronous-only.

Thank you for caring about this project.
