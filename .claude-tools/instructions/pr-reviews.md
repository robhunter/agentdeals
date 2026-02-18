## PR Self-Review Workflow

This document describes **how** to run automated PR reviews. Whether reviews are required depends on the active operating mode — see `operating-modes.md`.

### Running Reviews

```bash
# Initial review (can approve if no blockers)
.claude-tools/scripts/review-pr.sh start <pr-url>

# Follow-up review (cannot approve, for iteration)
.claude-tools/scripts/review-pr.sh continue <pr-url>
```

### Review Loop

Repeat until exit condition:

1. Push branch, create PR
2. Run `.claude-tools/scripts/review-pr.sh start <pr-url>`
3. Parse output for blockers/nits/acks
4. **Assess validity** of each comment:
   - Is it correct or hallucinated?
   - Is it already addressed?
   - Is it a real issue or style preference?
5. Fix valid issues; prefer fixing partially-valid over deferring
6. Post overview comment summarizing changes/rationale
7. Reply to **every** inline comment (even "not addressing because X")
8. Push fixes
9. Run `.claude-tools/scripts/review-pr.sh continue <pr-url>` to get feedback on fixes. If your fixes were accepted, go to step 2. If your fixes were not accepted or other blockers were presented, go to step 3.

### Exit Conditions

- **Success**: `start review` returns no blockers -> ready for user to merge
- **Circuit breaker**: 5 `start review` iterations -> escalate to user
- **Impasse**: hallucinations, repetitions, fundamental disagreement -> escalate with summary

### When to Escalate vs Self-Resolve

| Self-resolve | Escalate |
|--------------|----------|
| Clear bugs, missing null checks | Design disagreements |
| Valid style feedback | Ambiguous requirements |
| Missing tests | Reviewer asks for changes you believe are wrong |
| Partially-valid issues (prefer fix) | After 5 iterations |

### Responding to Comments

- Post ONE overview comment summarizing all changes and rationale
- Reply to EVERY inline comment individually:
  - If fixed: "Fixed in <commit>"
  - If not fixing: Explain why (design choice, out of scope, disagree)
  - If partially fixed: Explain what was done and what wasn't
- Use `gh pr comment` for overview, `gh api` for inline replies

### Credential Separation

The review script uses separate GitHub credentials for Gemini, stored at `~/.config/gemini-gh-token` (override with `GEMINI_GH_TOKEN_FILE` env var). This keeps Claude's and Gemini's GitHub access isolated.
