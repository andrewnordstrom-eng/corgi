# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 1.1.x   | Yes                |
| 1.0.x   | Security fixes only|
| < 1.0   | No                 |

## Reporting a Vulnerability

If you discover a security vulnerability, please report it responsibly:

1. **Do not** open a public GitHub issue with exploit details.
2. Use [GitHub private vulnerability reporting](https://github.com/andrewnordstrom-eng/corgi/security/advisories/new) to submit a report.
3. Include: reproduction steps, impact assessment, and suggested mitigation.
4. You will receive an acknowledgment within 48 hours and a resolution timeline within 7 days.

## Security Model

For the full security guide including threat model, operator checklist, and contributor security requirements, see [`docs/SECURITY.md`](docs/SECURITY.md).

## Scope

The following are **in scope** for security reports:

- Authentication and session management (governance login, admin DID allowlist)
- Governance integrity (vote manipulation, epoch transition abuse)
- Data exposure (PII leaks, audit log bypass)
- Infrastructure issues (SQL injection, SSRF, XSS)

The following are **out of scope**:

- Issues in upstream dependencies (report those to the respective projects)
- Social engineering of Bluesky app passwords (user responsibility)
- Denial of service via rate-limited endpoints
