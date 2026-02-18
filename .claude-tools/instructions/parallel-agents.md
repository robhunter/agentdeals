## Parallel Subagents

Run multiple general-purpose subagents concurrently, each in an isolated workspace with its own repo clone, branch, and port allocation.

### When to Use Parallel Agents

- Multiple independent issues/tasks with predominantly non-overlapping files
- Work that can be expressed as separate PRs
- Tasks where each agent owns a distinct module, package, or feature area

### When NOT to Use Parallel Agents

- Tasks that are fundamentally intertwined (e.g., both rewriting the same module)
- Work that has sequential dependencies (agent 2 needs agent 1's output)
- Simple changes that don't justify the setup overhead

### Workspace Isolation

Each agent gets its own directory with a full repo clone. The main workspace at `/workspace` remains untouched and acts as the coordinator's environment.

```
/workspace/                  # Coordinator (main conversation)
/workspace/.agent-workspaces/
  agent-0/                   # Agent 0's isolated clone
  agent-1/                   # Agent 1's isolated clone
  agent-2/                   # Agent 2's isolated clone
```

**Directory is gitignored.** Add `.agent-workspaces/` to `.gitignore`.

### Port Allocation

Each agent uses a dedicated port range to avoid conflicts. Pass these as environment variables when starting dev servers. Adapt the env var names and port numbers to your project's stack.

For example, a Node.js project with Vite + Express:

| Agent | Server Port | Client Port | Description |
|-------|-------------|-------------|-------------|
| Main  | 3001        | 5173        | Coordinator / manual testing |
| 0     | 3011        | 5183        | First parallel agent |
| 1     | 3021        | 5193        | Second parallel agent |
| 2     | 3031        | 5203        | Third parallel agent |

```bash
# Example: passing ports via env vars
PORT=3011 VITE_PORT=5183 npm run dev
```

Your project's dev scripts must respect port environment variables for this to work. If they don't, update them.

### Agent Setup Sequence

Each agent's prompt must include setup steps. The agent executes them at the start of its work. For example, in a Node.js project:

```bash
# 1. Clone the repo into isolated workspace
git clone /workspace /workspace/.agent-workspaces/agent-N
cd /workspace/.agent-workspaces/agent-N

# 2. Create a feature branch
git checkout -b agent-N/descriptive-branch-name

# 3. Install dependencies (adapt to your stack — e.g., pip install, cargo build)
npm install --cache /workspace/.agent-workspaces/.npm-cache

# 4. Set port environment variables (adapt env var names to your stack)
export PORT=30N1
export VITE_PORT=51N3
```

Using `git clone /workspace` (local clone) is fast since it uses hardlinks. No network round-trip needed.

### Prompt Template

When launching a parallel agent, include all context it needs to work independently. The agent has no access to the main conversation history.

```
You are working in an isolated workspace for a parallel development task.

## Setup
1. Clone: git clone /workspace /workspace/.agent-workspaces/agent-{N}
2. Work in: /workspace/.agent-workspaces/agent-{N}
3. Branch: agent-{N}/{branch-name}
4. Server port: {SERVER_PORT}, Client port: {CLIENT_PORT}
5. Install deps, e.g.: npm install --cache /workspace/.agent-workspaces/.npm-cache

## Task
{Detailed description of what to implement, including:}
- Which files to modify (be specific)
- Expected behavior / acceptance criteria
- Any relevant context from the codebase the agent needs to know

## Constraints
- Focus on the files and areas described above. You may touch other files if necessary to complete the task, but keep changes focused on your assigned scope.
- Push your branch and create a PR: gh pr create --base main --title "{PR title}"
- Use port {SERVER_PORT} for the server and {CLIENT_PORT} for the client.

## Standards
- You MUST follow all guidelines in CLAUDE.md and .claude-tools/instructions/
```

### Coordinator Workflow

The main conversation acts as coordinator:

1. **Analyze the work** — Break the work into tasks that can be done in parallel. Prefer tasks that focus on different areas of the codebase, but some file overlap is acceptable — merge conflicts can be resolved at merge time.
2. **Launch agents** — Spawn up to 3 general-purpose agents in parallel using `run_in_background: true`
3. **Monitor progress** — Read output files to check on agent status
4. **Review PRs** — In reviewed mode (see `operating-modes.md`), review each PR once agents complete (see `pr-reviews.md`). In exploratory mode, skip to user review.
5. **User merges** — The user reviews and merges PRs one at a time. After each merge, the user may ask the coordinator to rebase remaining PR branches and resolve any merge conflicts.

Example launching 3 agents (maximum) in a single message:

```
Task(subagent_type="general-purpose", run_in_background=true, prompt="...agent 0 prompt...")
Task(subagent_type="general-purpose", run_in_background=true, prompt="...agent 1 prompt...")
Task(subagent_type="general-purpose", run_in_background=true, prompt="...agent 2 prompt...")

# Check on progress later
Read(output_file_from_agent_0)
Read(output_file_from_agent_1)
Read(output_file_from_agent_2)
```

### Resource Considerations

**Memory:** Each workspace with installed dependencies and a running dev server can use 1-3GB. Size your Docker container accordingly:
- 1 agent: 4GB minimum
- 2 agents: 8GB minimum
- 3 agents: 12GB minimum

**Disk:** Each clone duplicates dependencies. For example, a typical Node.js project needs 500MB-1GB per workspace for `node_modules`. A shared package cache helps with install speed but not disk usage.

**CPU:** Parallel compilation and test runs are CPU-intensive. 4+ cores recommended for multi-agent work.

### Cleanup

After all agents complete and PRs are merged:

```bash
rm -rf /workspace/.agent-workspaces/
```

Or keep them around for debugging failed runs.

### Limitations

- **No shared state** — Agents cannot communicate with each other during execution. All coordination happens through the main conversation.
- **Context is prompt-only** — Each agent starts fresh. It doesn't see the main conversation. The prompt must be self-contained.
- **Merge conflicts** — If agents touch overlapping files, the user will merge PRs one at a time and ask the coordinator to rebase and resolve conflicts on remaining branches.
- **Port collisions** — If an agent ignores its port assignment or a port is already in use, the dev server will fail. Agents should check port availability before starting servers.
