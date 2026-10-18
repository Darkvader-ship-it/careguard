# Deprecation Policy for APIs and Configuration

This policy defines how features, API endpoints, and environment variables are deprecated, signaled to users, and eventually removed from CareGuard.

## Why Deprecation?

CareGuard evolves. Sometimes we rename endpoints, consolidate features, or drop support for old LLM models. Instead of removing things suddenly, we provide a migration path:

1. **Deprecate** (v1.1.0) — Old thing still works, warnings appear
2. **Support window** (at least 6 months) — Users migrate
3. **Remove** (v2.0.0) — Old thing gone, breaking change

This gives caregivers and integrations time to adapt.

## Deprecation Lifecycle

### Stage 1: Announce Deprecation

**What:** Feature still works, but users are warned.

**When:** New MINOR or MAJOR release (e.g., v1.1.0).

**How:** 
- Add deprecation notice to API response headers
- Log deprecation warnings to stderr/logs
- Update CHANGELOG.md with deprecation section
- Add `DEPRECATED` marker to docs
- Send notice in GitHub Discussions or email

**Example:** v1.1.0 ships, deprecates `POST /medications` endpoint

```javascript
// Server code
app.post('/medications', (req, res) => {
  // Log deprecation warning
  console.warn('Deprecation: POST /medications is deprecated as of v1.1.0 and will be removed in v2.0.0. Use POST /medications/request instead.');
  
  // Add deprecation header to response
  res.set('Deprecation', 'true');
  res.set('Sunset', 'Sun, 26 Jul 2026 00:00:00 GMT'); // sunset date
  res.set('Link', '</api/medications/request>; rel="successor-version"');
  
  // ... endpoint still works normally ...
});

// Dashboard code
if (process.env.DEPRECATED_POST_MEDS) {
  console.warn('⚠️  Your .env uses PHARMACY_PAYMENT_URL (deprecated). Rename to PHARMACY_ENDPOINT.');
}
```

### Stage 2: Support Window (6+ Months)

**What:** Old feature still works. Integrations migrate. New users use the replacement.

**When:** From deprecation date until removal date.

**Duration:** Minimum 6 months (e.g., v1.1.0 in January → v2.0.0 removal in July).

**Migration guidance:** Docs include worked examples showing old vs new code.

**Example:**

```markdown
## Migrating from POST /medications to POST /medications/request

**Before (v1.0.x):**
POST /medications
  body: { drug: "metformin", dosage: "500mg" }
  response: { medication_id: "...", price_estimate: 45.00 }

**After (v1.1.0+):**
POST /medications/request
  body: { drug: "metformin", dosage: "500mg", urgency: "routine" }
  response: { request_id: "...", status: "queued", eta_seconds: 120 }

**Sunset date:** July 26, 2026 (in v2.0.0)
```

### Stage 3: Remove

**What:** Old feature is gone. Breaking change, MAJOR version bump.

**When:** Next planned MAJOR release (e.g., v2.0.0).

**How:**
- Remove the code
- Remove from docs
- Add "Breaking Changes" section to CHANGELOG.md
- Update migration docs to point old users to the replacement

## Signals for Deprecation

Users learn about deprecations through multiple channels:

### 1. API Response Headers

Standard HTTP deprecation headers (from [RFC 8594](https://tools.ietf.org/html/rfc8594)):

```http
Deprecation: true
Sunset: Sun, 26 Jul 2026 00:00:00 GMT
Link: </api/medications/request>; rel="successor-version"
```

**What caregivers see:**
- Curl / Postman shows these headers in response
- Client libraries may parse and log warnings
- API monitors (Grafana) can alert on `Deprecation: true`

### 2. Response Payload

Include deprecation notice in the response body:

```json
{
  "medication_id": "med_456",
  "price_estimate": 45.00,
  "_deprecated": {
    "message": "POST /medications is deprecated as of v1.1.0 and will be removed in v2.0.0",
    "use_instead": "POST /medications/request",
    "sunset_date": "2026-07-26T00:00:00Z",
    "docs": "https://careguard.dev/docs/release/deprecation-policy.md"
  }
}
```

### 3. Logs and Warnings

Every call to deprecated feature logs to stderr:

```
⚠️  Deprecation Warning:
    Feature: POST /medications
    Deprecated in: v1.1.0
    Will be removed in: v2.0.0 (estimated 2026-07-26)
    Migration: Use POST /medications/request instead
    Docs: https://careguard.dev/docs/api#deprecated
```

### 4. Environment Variables

For deprecated env vars, check at startup and warn:

```bash
# .env (old style)
PHARMACY_PAYMENT_URL=http://pharmacy.local:3005

# Server starts and logs:
⚠️  Deprecation Warning:
    Environment variable: PHARMACY_PAYMENT_URL
    Deprecated in: v1.1.0
    Will be removed in: v2.0.0
    Rename to: PHARMACY_ENDPOINT
    Action required: Update your .env before upgrading to v2.0.0
```

### 5. CHANGELOG.md Section

Every release lists deprecations prominently:

```markdown
## v1.1.0 (2025-09-26)

### Deprecated
- `POST /medications` — Use `POST /medications/request` instead. Will be removed in v2.0.0.
- Environment variable `PHARMACY_PAYMENT_URL` — Renamed to `PHARMACY_ENDPOINT`. Will be removed in v2.0.0.

### New
- `POST /medications/request` — New urgent/routine request workflow.
- Env var `PHARMACY_ENDPOINT` — Replacement for `PHARMACY_PAYMENT_URL`.
```

### 6. GitHub Discussions & Announcements

Post a discussion for major deprecations:

```
Title: "Deprecation Notice: /medications endpoint sunset in v2.0.0"

Migration is straightforward: change your call from:
  POST /medications → POST /medications/request

Full migration guide: [link to docs]
Questions? Reply here.
```

## Deprecation Table Template

Use this table in your deprecation announcement. Update it as things are removed.

```markdown
## Deprecations and Removals

| Item | Type | Deprecated | Removal Target | Migration | Status |
|------|------|-----------|-----------------|-----------|--------|
| `POST /medications` | Endpoint | v1.1.0 (2025-09-26) | v2.0.0 (2026-07-26) | Use `POST /medications/request` | ✅ Announced |
| `PHARMACY_PAYMENT_URL` | Env var | v1.1.0 (2025-09-26) | v2.0.0 (2026-07-26) | Rename to `PHARMACY_ENDPOINT` | ✅ Announced |
| `audit_v1()` | Function | v1.0.5 (2025-07-01) | v1.1.0 (2025-09-26) | Use `audit_v2()` | ✅ Removed in v1.1.0 |
| Old Groq model `mixtral-8x7b-32k` | LLM | v1.1.0 (2025-09-26) | v2.0.0 (2026-07-26) | Migrate to `mixtral-8x7b` | ⏳ In support window |
```

## Environment Variable Deprecation (Worked Example)

### Scenario

CareGuard initially had separate env vars for pharmacy price and payment endpoints:

```bash
PHARMACY_PRICE_API=http://pharmacy.local:3001
PHARMACY_PAYMENT_API=http://pharmacy.local:3005
```

Over time, both became the same service, so we consolidated to:

```bash
PHARMACY_ENDPOINT=http://pharmacy.local:3001
```

Now we need to deprecate the old vars.

### Step 1: Deprecation Announcement (v1.1.0)

**Code change:**

```typescript
// src/config.ts

const PHARMACY_PRICE_API = process.env.PHARMACY_PRICE_API;
const PHARMACY_PAYMENT_API = process.env.PHARMACY_PAYMENT_API;
const PHARMACY_ENDPOINT = process.env.PHARMACY_ENDPOINT;

// Deprecation check
if (PHARMACY_PRICE_API || PHARMACY_PAYMENT_API) {
  console.warn(
    `⚠️  Deprecation Warning:
    Environment variables PHARMACY_PRICE_API and PHARMACY_PAYMENT_API
    are deprecated as of v1.1.0 and will be removed in v2.0.0.
    
    Migration:
      Old: PHARMACY_PRICE_API=http://pharmacy.local:3001
           PHARMACY_PAYMENT_API=http://pharmacy.local:3005
      
      New: PHARMACY_ENDPOINT=http://pharmacy.local:3001
      
    Action: Update your .env file and redeploy before upgrading to v2.0.0.
    Docs: https://careguard.dev/docs/release/deprecation-policy.md#env-var-migration`
  );
  
  // If new var not set, use old ones as fallback (for backward compat)
  if (!PHARMACY_ENDPOINT) {
    process.env.PHARMACY_ENDPOINT = PHARMACY_PRICE_API || PHARMACY_PAYMENT_API;
  }
}
```

**CHANGELOG.md entry:**

```markdown
### Deprecated
- Environment variables `PHARMACY_PRICE_API` and `PHARMACY_PAYMENT_API` 
  are consolidated into `PHARMACY_ENDPOINT`. 
  Old vars will be removed in v2.0.0.
  See [migration guide](docs/release/deprecation-policy.md#env-var-migration).
```

**.env.example update:**

```bash
# Old (deprecated in v1.1.0, removed in v2.0.0)
# PHARMACY_PRICE_API=http://pharmacy.local:3001
# PHARMACY_PAYMENT_API=http://pharmacy.local:3005

# New (v1.1.0+)
PHARMACY_ENDPOINT=http://pharmacy.local:3001
```

### Step 2: Support Window (6+ Months)

- v1.1.0 ships (2025-09-26)
- Server logs warning if old vars used
- Documentation shows side-by-side comparison
- GitHub Discussions has migration thread with examples
- Target removal: v2.0.0 (2026-07-26)

### Step 3: Removal (v2.0.0)

**Code change:**

```typescript
// src/config.ts

const PHARMACY_ENDPOINT = process.env.PHARMACY_ENDPOINT;

if (!PHARMACY_ENDPOINT) {
  throw new Error(
    `Missing required environment variable: PHARMACY_ENDPOINT. ` +
    `(Old vars PHARMACY_PRICE_API and PHARMACY_PAYMENT_API are no longer supported.)`
  );
}

// No fallback anymore — old vars are gone
```

**CHANGELOG.md entry:**

```markdown
### Breaking Changes
- **Removed:** Environment variables `PHARMACY_PRICE_API` and `PHARMACY_PAYMENT_API`. 
  Use `PHARMACY_ENDPOINT` instead.
  See [migration guide](docs/release/deprecation-policy.md#env-var-migration).
```

**Migration docs update:**

```markdown
## Removed in v2.0.0

### PHARMACY_PRICE_API and PHARMACY_PAYMENT_API

These environment variables were consolidated into `PHARMACY_ENDPOINT` in v1.1.0.

**If you're upgrading from v1.0.x to v2.0.0:**

1. Update your deployment configuration:
   OLD: PHARMACY_PRICE_API=http://...
        PHARMACY_PAYMENT_API=http://...
   NEW: PHARMACY_ENDPOINT=http://...

2. Redeploy and verify the service starts.
```

## Best Practices

1. **6-month minimum notice.** Don't surprise users. Give at least 6 months between deprecation and removal.

2. **Clear migration path.** Include worked examples. Bad: "Use the new endpoint." Good: "Change `POST /old` to `POST /new` and add `urgency: "routine"` to the body."

3. **Multiple signals.** Use response headers + logs + docs + changelog. Users might miss one.

4. **Version bounds.** Always state "deprecated in v1.1.0, removed in v2.0.0." Don't say "deprecated forever" or "will remove eventually."

5. **Link the successor.** In headers and response payloads, tell users exactly what to use instead.

6. **Test backward compat.** Before removal, maintain the old thing in code and test it still works alongside the new thing.

7. **No silent changes.** Don't change behavior of a "deprecated" thing. Make it work exactly as before, just with warnings.

## See Also

- [Versioning Guidelines](versioning.md) - How SemVer applies
- [Hotfix Process](hotfix-process.md) - Emergency releases
- [CONTRIBUTING.md](../../CONTRIBUTING.md) - Developer workflow
