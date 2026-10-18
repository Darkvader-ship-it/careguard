# Versioning and SemVer Guidelines

CareGuard follows [Semantic Versioning (SemVer)](https://semver.org/) with a single monorepo version. This document defines what constitutes a breaking change, how the version is tracked, and how it feeds the release workflow.

## Version Format

All releases follow the format:

```
v<MAJOR>.<MINOR>.<PATCH>
```

Examples: `v1.0.0`, `v1.2.3`, `v2.0.0`

- Tags are pushed to the repository as `v*` (e.g., `git tag v1.2.3`)
- The tag triggers the [release workflow](../../.github/workflows/release.yml)
- The workflow automatically updates `CHANGELOG.md` using [release-drafter](https://github.com/release-drafter/release-drafter)
- Dashboard and documentation versions always match the server version (single monorepo version)

## Monorepo Versioning Strategy

CareGuard is a monorepo with multiple services, but releases use **one unified version** for the entire project:

| Component | Version | Rationale |
|-----------|---------|-----------|
| Server (x402 APIs, MPP, Stellar) | `v<MAJOR>.<MINOR>.<PATCH>` | API contract critical |
| Dashboard (Next.js) | Same as server | UI/server must stay in sync |
| Agent (LLM + tool-use) | Same as server | Tools tied to server versioning |
| Shared types (`shared/types.ts`) | Same as server | Shared across all services |
| Database schema (if applicable) | Tracked in migration changelog | Schema breaking changes trigger MAJOR bump |

**Why single version?** Deployments are always atomic (server + dashboard + agent released together). A consumer pulling v1.2.3 gets all components at v1.2.3, with no version drift to debug.

## Breaking Changes (MAJOR Version Bump)

A breaking change is one where consumers (caregivers, dashboard, external tools) must take action before upgrading. Breaking changes include:

### API Contract Breaking Changes

- **Endpoint removed or renamed** — `/api/medications` becomes `/api/meds` (consumers update calls)
- **Required parameter added** — `POST /bills` now requires `provider_id` field (clients must send it)
- **Response schema changed** — `/bills` response changes from `{errors: [...]}` to `{issues: [...]}`  (clients parsing old schema break)
- **Authentication method changed** — From header auth to bearer token (integrations fail)
- **Mandatory field removed** — Response no longer includes `cost_estimate` (clients expecting it crash)

### Environment Variable Breaking Changes

- **Required env var added** — `AGENT_SECRET_KEY` becomes mandatory and server won't start without it
- **Env var renamed or removed** — `PHARMACY_API_URL` renamed to `PHARMACY_ENDPOINT` (deployments fail to parse old var)
- **Format changed** — `SPENDING_LIMIT` changes from `"1000"` (string) to required JSON object (parsing breaks)

### Internal Breaking Changes That Affect Deployment

- **Node.js version requirement increases** — v1.0.0 required Node 20, v2.0.0 requires Node 22 (deployments running Node 20 fail)
- **Database schema migration irreversible** — Drug interaction table column removed (rollback impossible)
- **Service port changed** — Agent moves from port 3004 to 3005 (reverse proxies/docker-compose break)

### Examples

**Breaking (MAJOR):**
- `POST /bills` endpoint is removed
- `OZ_FACILITATOR_API_KEY` env var becomes required
- Required `@stellar/stellar-sdk` v15 (incompatible with v14)
- Spending policy JSON schema changes format

**Not breaking (MINOR or PATCH):**
- New optional `POST /bills` parameter `audit_depth` (old calls work fine)
- New environment variable `AUDIT_CACHE_TTL` (optional, sensible default)
- Internal refactor of bill audit algorithm (same API, same results)
- Bug fix in interaction checking (behavior improves, API stays the same)

## Minor Version Bump (New Feature, Backward-Compatible)

A minor version bump adds new functionality or improvements with full backward compatibility.

### Minor Version Changes

- **New API endpoint** — `/api/bills/export` added (old clients ignore it, old functionality intact)
- **New optional env var** — `CACHE_TTL` added with default value (deployments work without setting it)
- **New optional response field** — `POST /bills` response adds `audit_confidence: 0.95` (clients ignoring it still work)
- **Performance improvement** — Drug interaction check is now 10x faster (same API, better results)
- **New optional parameter** — `GET /medications?include_prices=true` (old calls without param still work)
- **New dashboard feature** — Policy editor UI added (server unchanged, backward-compatible)

### Examples

**Minor (MINOR):**
- Add new optional endpoint `GET /medications/:id/price-history`
- Add new LLM tool for insurance claim analysis
- Improve error messages while keeping error codes the same
- Add new Grafana dashboard (monitoring feature, no API change)

**Not minor (MAJOR):**
- Remove the optional parameter (breaks old code)
- Change what the parameter does
- Change response structure even if field is optional

## Patch Version Bump (Bug Fixes, Hot Fixes)

A patch version bump fixes bugs, security issues, or typos with no new features.

### Patch Version Changes

- **Bug fix** — Drug interaction check incorrectly flagged ibuprofen + aspirin as dangerous (fixed)
- **Security fix** — x402 request validation was too lenient (tightened, API unchanged)
- **Performance fix** — Bill audit was O(n^2), now O(n log n) (API same, faster)
- **Typo fix** — Error message says "spening" instead of "spending"
- **Dependency patch** — OpenAI SDK bugfix updated

### Examples

**Patch (PATCH):**
- Fix: Pharmacy API rate limit was incorrectly counted per-call instead of per-second
- Fix: Dashboard chart didn't show 0-value spending days
- Security: Update `@stellar/stellar-sdk` from 14.2.0 to 14.2.1 (critical fix)
- Fix: Deprecation warning was logged twice in some cases

**Not patch (MINOR):**
- Add optional parameter to improve result accuracy
- Rewrite the algorithm while keeping the API the same

## Tracking Version in the Monorepo

There is **one source of truth** for the version:

| File | How It's Set | Who Updates It | When |
|------|-------------|---|---|
| Git tags | Manual `git tag v1.2.3` | Developer/CI | Before release push |
| `package.json` version field | Copy from git tag | Release workflow? Or manual | (currently no auto-sync; set manually) |
| `CHANGELOG.md` | Auto-updated by release-drafter | CI on tag push | On every release |
| GitHub Releases page | Auto-created by release-drafter | CI on tag push | On every release |

**Current process:**
1. Developer bumps version in `package.json` (MAJOR.MINOR.PATCH)
2. Developer creates git tag: `git tag v<MAJOR>.<MINOR>.<PATCH>`
3. Developer pushes tag: `git push origin v<MAJOR>.<MINOR>.<PATCH>`
4. GitHub Actions runs [release.yml](.github/workflows/release.yml):
   - Calls release-drafter to create GitHub Release
   - release-drafter reads commit messages since last tag (categorizes by type)
   - Calls changelog-updater to prepend release notes to CHANGELOG.md
   - Auto-commits updated CHANGELOG.md back to main

**Note:** The dashboard (`dashboard/package.json`) and root (`package.json`) should always have matching versions. If they drift, merges can be messy.

## Release Workflow Trigger

The release workflow is **triggered by git tags**:

```yaml
on:
  push:
    tags:
      - 'v*'
```

**How it works:**

```
Developer: git tag v1.2.0
Developer: git push origin v1.2.0
            ↓
GitHub Actions runs release.yml
            ↓
release-drafter/release-drafter:
  - Reads commit messages since v1.1.3
  - Categorizes as fix, feature, breaking-change (from PR labels)
  - Generates release notes
  - Creates GitHub Release for v1.2.0
            ↓
changelog-updater-action:
  - Fetches release body from GitHub Release
  - Prepends to CHANGELOG.md
  - Commits back to main
            ↓
✓ Release complete, CHANGELOG.md updated, GitHub Releases page live
```

## Commit Message Format for Release Categorization

The release workflow uses commit message type prefixes and PR labels to categorize changes:

```
<type>(scope): <description>

<body>

Resolves #ISSUE_NUMBER
```

**Types** (from [Conventional Commits](https://www.conventionalcommits.org/)):

| Type | Release Section | SemVer Impact | Example |
|------|-----------------|---------------|---------|
| `feat` | Features | MINOR | `feat(agent): add insurance claim analysis tool` |
| `fix` | Bug Fixes | PATCH | `fix(bill-audit): correct upcoding detection` |
| `docs` | Documentation | None | `docs: add cost-estimation guide` |
| `perf` | Performance | PATCH | `perf(interaction-check): optimize O(n^2) to O(n log n)` |
| `test` | Tests | None | `test: add bill-audit edge case tests` |
| `chore` | Other | None | `chore: update dependencies` |
| `ci` | CI/CD | None | `ci: add code-coverage check to CI` |

**PR labels** override commit messages if needed:

| Label | Effect |
|-------|--------|
| `breaking-change` | Bumps MAJOR version, appears in release notes as "Breaking Changes" |
| `security` | Highlights security fixes in release notes |

Example:

```
commit: feat(dashboard): add policy builder UI
PR label: "breaking-change"    # ← This makes it MAJOR, not MINOR
Result: Release notes show this as a breaking change, even though feat usually means MINOR
```

## Deprecation Workflow

New in v1.1.0? Deprecate the old thing. See [Deprecation Policy](deprecation-policy.md) for details.

A deprecation does **not** require a major version bump if the old thing still works:

```
Old API: POST /medications (deprecated in v1.1.0, still works)
New API: POST /medications/request (new in v1.1.0)
Removed: v2.0.0 (at least 6 months notice)

Versions:
v1.1.0 = MINOR (new feature + deprecation notice, old API still works)
v2.0.0 = MAJOR (breaking: old API finally removed)
```

## Hotfixes and Patch Releases

For urgent production fixes that can't wait for the next planned release, see [Hotfix Process](hotfix-process.md).

Hotfixes are typically released as patch versions (v1.2.5, not v1.3.0) unless they add significant features.

## Rollback Procedure

If a release introduces a critical bug, see [Rollback Procedure](rollback.md) for how to revert safely without losing data.

---

## Quick Reference

| Change | Version Bump | Example |
|--------|--------|---------|
| Security fix, bug fix | PATCH | v1.2.3 → v1.2.4 |
| New optional feature | MINOR | v1.2.3 → v1.3.0 |
| New required parameter, removed endpoint | MAJOR | v1.2.3 → v2.0.0 |
| Breaking env var, Node version bump | MAJOR | v1.2.3 → v2.0.0 |
| Internal refactor (no API change) | PATCH or MINOR | v1.2.3 → v1.2.4 or v1.3.0 |

---

## See Also

- [Deprecation Policy](deprecation-policy.md) - How to deprecate features safely
- [Hotfix Process](hotfix-process.md) - Emergency release workflow
- [Rollback Procedure](rollback.md) - How to revert a bad release
- [CONTRIBUTING.md](../../CONTRIBUTING.md) - Development workflow
