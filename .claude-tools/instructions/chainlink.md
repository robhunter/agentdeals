## Chainlink Issue Tracking (MANDATORY)

All development work MUST be tracked using [chainlink](https://github.com/dollspace-gay/chainlink). No exceptions.

### Session Workflow

```bash
# Start every work session
chainlink session start

# Mark what you're working on
chainlink session work <issue_id>

# Add discoveries/notes as you work
chainlink comment <issue_id> "Found: ..."

# End session with handoff notes
chainlink session end --notes "Completed X, Y pending"
```

### Issue Management

```bash
# Create issues
chainlink create "Issue title" -p <low|medium|high|critical>
chainlink subissue <parent_id> "Subtask title"

# Track dependencies
chainlink block <blocked_id> <blocker_id>
chainlink unblock <blocked_id> <blocker_id>

# Find work
chainlink ready          # Issues with no open blockers
chainlink next           # Suggested next issue
chainlink list           # All open issues
chainlink tree           # Hierarchical view

# Update progress
chainlink update <id> -s <open|in_progress|review|closed>
chainlink close <id>
chainlink comment <id> "Progress update..."

# Milestones
chainlink milestone create "v1.0"
chainlink milestone add <milestone_id> <issue_id>
```

### Rules

1. **Create issues BEFORE starting work** — No undocumented changes
2. **Use `session work`** — Always mark current focus
3. **Add comments** — Document discoveries, blockers, decisions
4. **Close with notes** — Future you will thank present you
5. **Large features** — Break into subissues, never exceed 500 lines per file

### Priority Guide

- `critical`: Blocking other work, security issue, production down
- `high`: User explicitly requested, core functionality
- `medium`: Standard features, improvements
- `low`: Nice-to-have, cleanup, optimization

### Task Breakdown

```bash
# Single task
chainlink create "Fix login validation" -p medium

# Multi-part feature -> Epic with subissues
chainlink create "Add user authentication" -p high     # Epic (parent)
chainlink subissue 1 "Create user model"               # Component 1
chainlink subissue 1 "Add login endpoint"              # Component 2
chainlink subissue 1 "Add session middleware"           # Component 3
```

| Scenario | Action |
|----------|--------|
| User asks for a feature | Create epic + subissues if >2 components |
| User reports a bug | Create issue, investigate, add comments |
| Task has multiple steps | Create subissues for each step |
| Work will span sessions | Create issue with detailed comments |
| You discover related work | Create linked issue |

### Context Window Management

When conversation is long or task needs many steps:
1. Create tracking issue: `chainlink create "Continue: <summary>" -p high`
2. Add notes: `chainlink comment <id> "<what's done, what's next>"`
