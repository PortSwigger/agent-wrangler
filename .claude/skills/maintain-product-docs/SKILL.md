---
name: maintain-product-docs
description: Use when adding, changing, or removing user-visible Agent Wrangler features, skills, MCP tools, settings, shortcuts, workflows, or extensions, or when auditing the README and product guides for drift.
---

# Maintain product documentation

Keep the documentation discoverable for someone who does not already know a feature exists. A feature
is not documented merely because its label appears in the UI or its agent metadata can trigger it.

## Documentation map

| Surface | Canonical guide |
| --- | --- |
| Product overview and feature navigation | `README.md` |
| Board, session lifecycle, tasks, settings, shortcuts | `docs/board-and-sessions.md` |
| Agent-facing skills and example requests | `docs/agent-capabilities.md` |
| Review and PR automation | `docs/reviews-and-prs.md` |
| Core MCP tools | `docs/agent-tools.md` |
| Extension installation and authoring | `docs/extensions.md` |

## Workflow

1. Identify the change from the issue, PR, commit range, and tests. Trace its externally observable
   behavior, entry points, defaults, persistence, provider differences, and failure states.
2. Update the narrow guide that owns the behavior. Add or adjust the README feature index when the
   change introduces a new category or materially changes the product's headline value.
3. Reconcile the complete registries, not only the changed files:
   - `agent-skills/skills/*/SKILL.md` against `docs/agent-capabilities.md`.
   - `server/mcp/tools/index.js` against `docs/agent-tools.md`.
   - Session and task menus in `public/app.js`, settings in `public/settings.js`, dispatch controls in
     `public/index.html`, and shortcuts in `public/shortcuts.js` against the relevant user guide.
   - Extension manifest and host API changes against `docs/extensions.md`.
4. Use canonical UI labels and tool/skill names so repository search finds the documentation.
5. Run `npm run docs:check`. It also checks that the canonical guides and this maintenance skill are
   not hidden by Git ignore rules. If the checker changed, run
   `node --test scripts/check-doc-coverage.test.js` first, then the full `npm test` suite.
6. Read the changed pages as a new user: the README should lead to the feature, the guide should say
   when to use it, and agent capabilities should include an example request.

## Common misses

- Documenting only the latest diff while an entire surrounding workflow remains undiscoverable.
- Naming a skill without explaining what a human should ask for.
- Treating peer review, adversarial PR review, and diff comments as the same workflow.
- Omitting settings defaults, per-session overrides, persistence, or Claude/Codex differences.
- Updating implementation invariants while leaving the user-facing extension quick start stale.
- Copying exhaustive details into the README instead of linking a focused guide.
