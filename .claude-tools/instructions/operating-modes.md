## Operating Modes

Operating modes control how much process rigor is applied during a session. The active mode is set per-project in that project's `CLAUDE.md`:

```markdown
## Operating Mode: exploratory
```

If no mode is set, default to **exploratory**.

### Exploratory Mode

Ship fast. The human is out of the loop — develop autonomously.

- Develop on a feature branch, then merge and push to main when ready
- No PR review gate — neither automated (Gemini) nor human approval required before merging
- Automated Gemini review is **optional** — use it when you want a second opinion, not as a gate
- All other standards (tests, coverage, chainlink tracking, commit hygiene) still apply

### Reviewed Mode

Every PR goes through automated review and human approval before merging.

- Run the Gemini review process (see `pr-reviews.md`) on every PR with 15+ lines of logical code
- "Logical code" means implementation changes — not whitespace, comments, imports, config, or mechanical renames. Test-only PRs still go through review.
- Do not present the PR to the user until the review loop exits cleanly (no blockers, circuit breaker, or impasse — see `pr-reviews.md` for exit conditions)
- The user reviews and merges — do not merge PRs without human approval
- For stacked PRs, write the full stack first, then review each PR afterward
