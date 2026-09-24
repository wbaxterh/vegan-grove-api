# Security policy

Vegan Grove is a privacy-first platform for activists. Reports that protect members are the most valuable contribution anyone can make.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting on this repository (Security tab, "Report a vulnerability"). Do not open a public issue for security problems.

Include what you found, how to reproduce it, and what data or members it could affect. You will get an acknowledgement within 72 hours and a status update when a fix ships.

## Scope

All four Vegan Grove repositories (`vegan-grove-api`, `vegan-grove-web`, `vegan-grove-mobile`, `vegan-grove-docs`) and the production services at `vegangrove.org`, `api.vegangrove.org`, and `docs.vegangrove.org`.

Please do not test against production with real member data, do not attempt denial of service, and do not access data that is not yours. A local run of the API against your own database is the right place to reproduce most issues.

## What we care about most

- Anything that reveals a member's identity, email, area, friends, RSVPs, or messages to someone who should not see them.
- Authentication and session bugs.
- Media or upload paths that leak location metadata.
- Secrets in the repository or its history.

## Disclosure

We fix first, then publish a short note in the docs release notes. Reporters are credited if they want to be.
