# Security Policy

## Reporting a Vulnerability

CareGuard handles real financial transactions on the Stellar network.
If you discover a security vulnerability, please report it privately before
disclosing it publicly.

**Do not** open a public GitHub issue for security vulnerabilities.

### How to Report

1. Go to **Security → Advisories → New advisory** in this repository, or
   open a [private advisory directly](https://github.com/harystyleseze/careguard/security/advisories/new).
2. Include:
   - A brief description of the vulnerability
   - Steps to reproduce or a proof of concept
   - The affected version(s) and component(s)
   - Any potential impact you have identified

You can also email the maintainers directly (referenced in
[CONTRIBUTING.md](CONTRIBUTING.md)).

### What to Expect

- **Acknowledgment** within 48 hours of your report.
- **Initial assessment** within 5 business days.
- **Coordinated disclosure**: we will work with you on a timeline for
  publishing a fix and the advisory. We aim to release a patch within
  14 days of confirmation for critical issues.
- **Credit**: reporters are credited in the advisory and changelog unless
  they prefer to remain anonymous.

## Supported Versions

| Version | Supported |
|---------|-----------|
| Latest release | ✅ |
| Previous release | ⚠️ Security patches only |
| Older releases | ❌ |

## Scope

This security policy covers the CareGuard server, dashboard, smart contracts,
and deployment infrastructure. For services hosted by third parties (Stellar
network, Groq LLM, OpenZeppelin facilitator), refer to their respective
security policies.

## Threat Model

For a detailed threat model covering LLM prompt injection, spending policy
controls, Stellar key management, and dependency risks, see
[docs/SECURITY.md](docs/SECURITY.md).

## Disclosure Timeline

| Phase | Duration |
|-------|----------|
| Acknowledgment | ≤ 48 hours |
| Triage & assessment | ≤ 5 business days |
| Fix development | ≤ 14 days (critical) |
| Public disclosure | Coordinated with reporter |
