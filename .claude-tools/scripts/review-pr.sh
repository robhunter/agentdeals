#!/bin/bash
set -e

MODE=$1      # "start" or "continue"
PR_URL=$2    # e.g., https://github.com/owner/repo/pull/N

if [[ -z "$MODE" || -z "$PR_URL" ]]; then
    echo "Usage: review-pr.sh start|continue <pr-url>"
    echo "Example: review-pr.sh start https://github.com/robhunter/bsky-topics/pull/9"
    exit 1
fi

if [[ "$MODE" != "start" && "$MODE" != "continue" ]]; then
    echo "Error: MODE must be 'start' or 'continue'"
    exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROMPT_TEMPLATE="$SCRIPT_DIR/../prompts/${MODE}-review.md"

if [[ ! -f "$PROMPT_TEMPLATE" ]]; then
    echo "Error: Prompt template not found: $PROMPT_TEMPLATE"
    exit 1
fi

# Load Gemini's GitHub token from .env.gemini (separate from Claude's credentials)
# Look in project root (two levels up from script location)
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
GEMINI_ENV_FILE="${GEMINI_ENV_FILE:-$PROJECT_ROOT/.env.gemini}"

if [[ ! -f "$GEMINI_ENV_FILE" ]]; then
    echo "Error: Gemini env file not found: $GEMINI_ENV_FILE"
    echo "Create .env.gemini with GH_TOKEN=<token>, or set GEMINI_ENV_FILE env var"
    exit 1
fi

# Parse GH_TOKEN from .env.gemini (handles comments and whitespace)
GEMINI_GH_TOKEN=$(grep -E '^[[:space:]]*GH_TOKEN=' "$GEMINI_ENV_FILE" | sed 's/^[[:space:]]*GH_TOKEN=//' | tr -d '[:space:]')

if [[ -z "$GEMINI_GH_TOKEN" ]]; then
    echo "Error: GH_TOKEN not found in $GEMINI_ENV_FILE"
    exit 1
fi

# Substitute PR URL in prompt template
PROMPT_CONTENT=$(sed "s|{{PR_URL}}|$PR_URL|g" "$PROMPT_TEMPLATE")

# Run gemini with its own GitHub creds (isolated from Claude's credentials)
# Note: --sandbox removed because Claude's container provides isolation
# Pass prompt via stdin since -p flag is deprecated
echo "$PROMPT_CONTENT" | GH_TOKEN="$GEMINI_GH_TOKEN" gemini --yolo
