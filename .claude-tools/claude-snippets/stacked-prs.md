### Stacked PRs (Preferred Workflow)

For multi-part features, use **stacked PRs** instead of one large PR:

**Why stack PRs:**
- Smaller PRs are easier to review (target 200-400 lines of diff)
- Reviewers can approve early parts while later parts are still in progress
- Feedback on one layer doesn't block progress on others
- Each PR has a focused scope and clear purpose

**When to split into stacked PRs:**
- Feature touches multiple layers (data model → business logic → API → tests)
- Total diff would exceed 500 lines
- Logical separation exists (e.g., "add module" vs "integrate module")
- Different parts could be reviewed by different people

**How to create a stack:**

CRITICAL: All PRs target `main`. Never use `--base <branch>` for stacked PRs.

```bash
# Start from main
git checkout main && git pull

# Create first PR branch
git checkout -b feature-1-foundation
# ... make changes, commit, push
gh pr create --base main --title "Add foundation for X"

# Create second PR branch FROM the first (for local development)
git checkout -b feature-2-integration
# ... make changes, commit, push
gh pr create --base main --title "Integrate X into Y"  # Still targets main!

# Create third PR branch FROM the second
git checkout -b feature-3-tests
# ... make changes, commit, push
gh pr create --base main --title "Add tests for X integration"  # Still targets main!
```

**Why all PRs target main:** If PRs target parent branches, merging PR #1 does NOT merge it to main - it merges to the parent branch. This causes code to be "merged" but never reach main.

**Naming convention:** `feature-N-description` where N indicates stack order.

**When earlier PRs change:**
If PR #1 needs changes after review, update the entire stack:
```bash
# Fix issues on PR #1's branch
git checkout feature-1-foundation
# ... make fixes, commit, push

# Rebase PR #2 onto updated PR #1
git checkout feature-2-integration
git rebase feature-1-foundation
git push --force-with-lease

# Rebase PR #3 onto updated PR #2
git checkout feature-3-tests
git rebase feature-2-integration
git push --force-with-lease
```

**Merging order:** Merge PRs bottom-up (PR #1 first). GitHub will auto-update the diffs for later PRs since they all target main.
