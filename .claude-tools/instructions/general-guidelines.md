## General Guidelines

### User Approval

Ask the user to approve:
- Important design decisions
- Dangerous changes (e.g., deleting data)

### After Context Compaction

When a conversation is resumed from a summary:
1. **Do NOT automatically continue with "next steps"** mentioned in the summary
2. Summaries describe what was *planned*, not what was *approved*
3. Before starting any new phase or major work item, confirm with the user
4. When in doubt, ask: "The summary mentions X as next. Should I proceed?"

### When User Expresses Frustration

- STOP and re-read their previous messages
- Their frustration likely means you missed a requirement
- Verify understanding before writing more code
