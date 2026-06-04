# Gated PR Merge Workflow

How a PR — whether opened by IFleet or by a human — moves from draft to merged.
Covers the normal path and the emergency admin-merge path.

---

## Normal merge path

1. IFleet opens a **draft PR** with CI configured to run on push.
2. CI runs the full check suite (type-check, lint, tests).
3. A human reviewer reads the diff, the verifier report, and any behavioral fingerprint diff.
4. The reviewer hits **Approve** and converts draft → ready-for-review.
5. Branch protection enforces: at least one approval + all required status checks green.
6. Reviewer (or Seb) hits **Merge** — GitHub enforces the protection rules automatically.

**The normal path never uses `--admin` or any protection bypass.**

---

## Emergency / incident admin-merge path

`gh pr merge --admin` overrides branch-protection rules (required reviews, required status
checks). It is **not a routine shortcut**. Use it only when all of the following are true:

- CI is broken for infrastructure reasons unrelated to this PR, **and**
- the production impact of waiting (e.g. a live incident is unresolved) exceeds the risk
  of skipping automated checks, **and**
- a human has read the diff and is confident it is safe to merge.

### Accountability requirements (mandatory before running `--admin`)

1. **Discord confirmation** — post in **#ifleet** (channel `1504120127791042631`) BEFORE
   running the command. Use this exact format:

   ```
   [admin-merge] PR#NNN reason: <reason> operator: <handle>
   ```

2. **Audit log entry** — add the same message as a comment on the PR **or** append it to
   the local audit log (`./ifleet-rollback.log` or `/var/log/pm2/ifleet-rollback.log`)
   so there is a durable record of who ran it, why, and which PR.

Without both entries, the merge is undocumented and violates the operating standard.

### Example

```
# Discord first:
[admin-merge] PR#342 reason: CI infra down (GitHub Actions outage), revert is in prod-critical path operator: @monstersebas1

# Then merge:
gh pr merge 342 --admin --merge
```

---

## Split-task / worktree PRs

PRs opened from a `splittasks/` branch follow the same gated path. T1 (orchestrator)
reviews the done-report, runs the arbiter if Claude and Codex disagree, and merges only
after the review gate passes. Admin-merge from T1 is subject to the same accountability
requirements above — the split-task context does not create an exception.

---

## Reference

- `deploy/rollback.sh` — automated revert script; its final log message references this
  document for the admin-merge protocol.
- `docs/elevation/operating-standard.md §Rollback path` — liability framing for human
  reviewers.
- Discord #ifleet channel ID: `1504120127791042631`.
