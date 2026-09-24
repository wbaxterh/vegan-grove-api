# Product principles checklist

Read `SOUL.md` first. Work through this before proposing completion of any change. Copy the PR summary block at the bottom into the pull request.

## 1. Privacy and data minimization (always first)

- [ ] The change collects no new personal data, or the new field is listed in `docs/privacy/data-inventory` with purpose, visibility, and retention.
- [ ] No profile, handle page, friend list, RSVP list, or location becomes visible to anyone it was not visible to before.
- [ ] No device GPS, request body, token, or email reaches logs, analytics, or third parties.
- [ ] New media paths strip EXIF before upload.
- [ ] Deleting an account still removes everything this change stores.
- [ ] Nothing in docs or code names a host, IP, instance, port, PEM, or SSH command.

## 2. Activist value

- [ ] Names the real-world action this helps a member take.
- [ ] Organizers can do their job with fewer taps than before, not more.
- [ ] Businesses and orgs are guests; nothing here lets them reach members directly.

## 3. Trust and correctness

- [ ] Auth checks are server-side and use the session, never a body field, to identify the principal.
- [ ] Every list is filtered by visibility before it leaves the API.
- [ ] Input is validated with zod at the route boundary.
- [ ] Failure states are handled: empty, loading, offline, denied, rate-limited.
- [ ] Tests cover the happy path and the permission boundary.

## 4. Simplicity and hierarchy

- [ ] Context, Action, Support: the screen says what it is, what to do, and what helps.
- [ ] One way to do the thing. No duplicate paths.
- [ ] Raw backend fields (ids, lat/lng, enums) are never the primary UI.

## 5. Data UX rules

- [ ] Places show vegan level and type before anything else.
- [ ] Events show when, where (as much as the organizer allows), and who is hosting.
- [ ] Counts are shown; identities are not, unless the viewer is allowed to see them.

## 6. Companion (if touched)

- [ ] Prompts include only the handle and stated interests.
- [ ] Unpinned conversations still expire.
- [ ] Tool calls read public data only (places, events, guides, media).
- [ ] The model id is configuration, not a literal in the code path.

## 7. Feedback loop

- [ ] One signal named that shows the change worked, computed as an aggregate.
- [ ] Rollback plan written.

## 8. Aesthetic consistency

- [ ] Uses the shared tokens (`--vg-*`); no new hex values in components.
- [ ] Dark mode first, light mode correct.
- [ ] No third-party fonts or icon CDNs.

## PR summary block (copy into the PR)

```
Activist outcome:
What changed:
Privacy and trust checks done:
Signal to watch:
Rollback plan:
```
