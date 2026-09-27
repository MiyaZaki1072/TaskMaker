# Security policy

Problem Studio is meant to be reachable from the internet, so security reports are taken seriously.

## Reporting a vulnerability

**Please don't open a public issue.** Report it privately instead:

1. Go to the repository's **Security** tab.
2. Click **Report a vulnerability** and describe what you found.

Only the maintainer can see the report. Helpful details: what an attacker could do, the steps or
request that triggers it, and which version (commit) you tested.

You should hear back within a week. Once a fix is ready it ships on `main`, and the report is
credited to you unless you'd rather stay anonymous.

## Supported versions

Only the latest `main` is supported — self-hosted installs should update to it to get fixes.

## In scope

Anything that lets someone without the studio password read or change problems, get past the
sign-in or cross-site checks, run code in the browser or on the server (for example through an
uploaded SVG or ZIP), or take the service down with a single cheap request. `README.md` → *Security*
describes what the studio deliberately does *not* try to be (no per-user accounts or audit log).
