---
description: Spawn a cross-provider (Claude <-> Codex) sibling/child session to adversarially review a pull request, and report concerns back via mail.
---

Follow the `adversarial-pr-review` skill to review $ARGUMENTS (a PR number/URL if given,
otherwise resolve the PR yourself as the skill describes).

Once you've spawned the reviewer and briefed it, you're done here — it works
asynchronously and reports back to your mailbox when it's finished. Tell the user you've
kicked it off; don't wait around for its mail before ending your turn.
