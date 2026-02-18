# Claude Tools

Shared tooling for Claude Code workflows across projects.

## Contents

```
.claude-tools/
├── scripts/
│   └── review-pr.sh           # Automated PR review runner
├── prompts/
│   ├── start-review.md        # Initial review prompt (can approve)
│   └── continue-review.md     # Follow-up review prompt (cannot approve)
├── instructions/
│   ├── operating-modes.md     # Reviewed vs exploratory mode
│   ├── chainlink.md           # Chainlink issue tracking workflow
│   ├── definition-of-done.md  # Verification, approval, and completion standards
│   ├── general-guidelines.md  # User approval, context compaction, frustration handling
│   ├── github-prs.md          # Git commit rules and stacked PR workflow
│   ├── pr-reviews.md          # PR self-review how-to reference
│   └── parallel-agents.md     # Parallel subagent workspace isolation
└── claude-snippets/           # (legacy, migrating to instructions/)
    ├── stacked-prs.md         # → see instructions/github-prs.md
    └── self-review.md         # → see instructions/pr-reviews.md
```

## Setup

### 1. Clone into your project

```bash
cd your-project
git clone git@github.com:robhunter/claude-tools.git .claude-tools
```

### 2. Add to .gitignore

Add `.claude-tools/` to your project's `.gitignore` to avoid nesting repos:

```bash
echo ".claude-tools/" >> .gitignore
```

### 3. Set up Gemini credentials

Create `.env.gemini` in your project root with Gemini's GitHub token:

```bash
# .env.gemini
GH_TOKEN=ghp_your_gemini_token_here
```

Make sure it's gitignored (add `.env.gemini` to `.gitignore`).

To use a different location, set `GEMINI_ENV_FILE`:

```bash
export GEMINI_ENV_FILE=/path/to/.env.gemini
```

### 4. Reference instructions in your claude.md

Add a reference to the instructions directory in your project's `claude.md`:

```markdown
## Workflows

Follow all guidelines in `.claude-tools/instructions/`:
- `operating-modes.md` — Reviewed vs exploratory mode
- `github-prs.md` — Git commit rules and stacked PR workflow
- `pr-reviews.md` — PR self-review how-to reference
- `parallel-agents.md` — Parallel subagent workspace isolation
```

## Usage

### PR Review

```bash
# Initial review (can approve if no blockers)
.claude-tools/scripts/review-pr.sh start https://github.com/owner/repo/pull/123

# Follow-up review after making changes
.claude-tools/scripts/review-pr.sh continue https://github.com/owner/repo/pull/123
```

The script:
1. Loads Gemini's GitHub token from `~/.config/gemini-gh-token`
2. Substitutes the PR URL into the prompt template
3. Runs `gemini --yolo --sandbox` with isolated credentials

### Credential Isolation

The review script sets `GH_TOKEN` only for the gemini subprocess. Claude's credentials (from `.env` or `gh auth login`) remain unaffected.

## Updating

To pull updates:

```bash
cd .claude-tools
git pull origin main
```
