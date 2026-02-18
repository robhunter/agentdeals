### Self-Review Workflow

When a PR is ready for review, run the automated review process before asking the user.

**Running Reviews:**
```bash
# Initial review (can approve if no blockers)
.claude-tools/scripts/review-pr.sh start <pr-url>

# Follow-up review (cannot approve, for iteration)
.claude-tools/scripts/review-pr.sh continue <pr-url>
```

**Review Loop:**
1. Push branch, create PR
2. Run `.claude-tools/scripts/review-pr.sh start <pr-url>` (iteration 1)
3. Parse output for blockers/nits/acks
4. **Assess validity** of each comment:
   - Is it correct or hallucinated?
   - Is it already addressed?
   - Is it a real issue or style preference?
5. Fix valid issues; prefer fixing partially-valid over deferring
6. Post overview comment summarizing changes/rationale
7. Reply to **every** inline comment (even "not addressing because X")
8. Push fixes
9. Run `.claude-tools/scripts/review-pr.sh continue <pr-url>`
10. Gemini will REPLY to original comments assessing your fixes
11. If gemini raises new issues or rejects fixes, go to step 4
12. If gemini approves (begrudgingly or otherwise), run `start` again (iteration 2)
13. Repeat until exit condition

**Exit Conditions:**
- **Success**: `start` review returns no blockers → ready to merge
- **Circuit breaker**: 2 `start` reviews → escalate to user (you may run `continue` many times between each `start`)
- **Impasse**: hallucinations, repetitions, fundamental disagreement → escalate with summary

**Before Escalating (MANDATORY):**
1. Reply to ALL open inline comments in the PR
2. For each comment, explain either:
   - How it was fixed (with commit hash)
   - Why you're not addressing it (with reasoning)
3. Post a final overview comment summarizing the escalation
4. The user should be able to review the PR comments directly without needing additional context

**When to Escalate vs Self-Resolve:**

| Self-resolve | Escalate |
|--------------|----------|
| Clear bugs, missing null checks | Design disagreements |
| Valid style feedback | Ambiguous requirements |
| Missing tests | Reviewer asks for changes you believe are wrong |
| Partially-valid issues (prefer fix) | After 2 iterations |

**Responding to Comments:**
- Post ONE overview comment summarizing all changes and rationale
- Reply to EVERY inline comment individually:
  - If fixed: "Fixed in <commit>"
  - If not fixing: Explain why (design choice, out of scope, disagree)
  - If partially fixed: Explain what was done and what wasn't
- Use `gh pr comment` for overview, `gh api` for inline replies

**API Pagination (CRITICAL):**
- Always use `--paginate` when fetching PR comments: `gh api repos/OWNER/REPO/pulls/N/comments --paginate`
- GitHub API returns 10 results per page by default
- Missing pagination = missing comments from later review rounds

**Credential Separation:**
The review script uses separate GitHub credentials for Gemini, stored at `~/.config/gemini-gh-token` (override with `GEMINI_GH_TOKEN_FILE` env var). This keeps Claude's and Gemini's GitHub access isolated.
