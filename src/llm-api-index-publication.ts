import type { ReadmeCensus } from "./llm-api-readme.js";

export const CATALOGUE_REPO = "robhunter/agentdeals";

export const PUBLISHED_README_PATH = "README.md";

export const REPO_ENV = "AGENTDEALS_LLM_INDEX_REPO";
export const BRANCH_ENV = "AGENTDEALS_LLM_INDEX_BRANCH";
export const PATH_ENV = "AGENTDEALS_LLM_INDEX_README_PATH";
export const TOKEN_ENV = "AGENTDEALS_LLM_INDEX_TOKEN";

const OWNER_AND_NAME = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

export interface PublicationTarget {
  repo: string;
  branch: string | null;
  path: string;
  token: string;
}

export type TargetReading =
  | { state: "unnamed"; because: string }
  | { state: "unusable"; because: string }
  | { state: "named"; target: PublicationTarget };

function trimmed(value: string | undefined): string {
  return (value ?? "").trim();
}

export function publicationTarget(env: Record<string, string | undefined>): TargetReading {
  const repo = trimmed(env[REPO_ENV]);
  if (repo === "") {
    return {
      state: "unnamed",
      because: `${REPO_ENV} names no repository, so the index is published in this repository's own tree and nowhere else.`,
    };
  }
  if (!OWNER_AND_NAME.test(repo)) {
    return {
      state: "unusable",
      because: `${REPO_ENV} reads ${JSON.stringify(repo)}, which is not an owner/name pair.`,
    };
  }
  const path = trimmed(env[PATH_ENV]) || PUBLISHED_README_PATH;
  if (repo === CATALOGUE_REPO && path === PUBLISHED_README_PATH) {
    return {
      state: "unusable",
      because: `${REPO_ENV} names ${CATALOGUE_REPO} and ${PATH_ENV} names ${PUBLISHED_README_PATH}, which is this repository's own README. The index is a separate artefact and replacing this repository's front page with it is never the intent.`,
    };
  }
  const token = trimmed(env[TOKEN_ENV]);
  if (token === "") {
    return {
      state: "unusable",
      because: `${REPO_ENV} names ${repo} but ${TOKEN_ENV} is empty, so nothing can be written there. A named repository nobody can write to publishes a stale index rather than no index.`,
    };
  }
  return { state: "named", target: { repo, branch: trimmed(env[BRANCH_ENV]) || null, path, token } };
}

export interface RemoteFile {
  content: string;
  sha: string;
}

export interface RemoteReading {
  repoExists: boolean;
  defaultBranch: string | null;
  branchCount: number;
  branchExists: boolean;
  file: RemoteFile | null;
}

export function publicationBranch(target: PublicationTarget, remote: RemoteReading): string | null {
  return target.branch ?? remote.defaultBranch;
}

export type PublicationAction = "create" | "update" | "unchanged" | "refuse";

export interface Publication {
  action: PublicationAction;
  branch: string | null;
  sha: string | null;
  because: string;
}

export interface PublicationInput {
  rows: number;
  generated: string;
  held: string | null;
  target: PublicationTarget;
  remote: RemoteReading;
}

export function publicationDecision(input: PublicationInput): Publication {
  const { rows, generated, held, target, remote } = input;
  const refuse = (because: string): Publication => ({ action: "refuse", branch: null, sha: null, because });

  if (rows === 0) {
    return refuse(
      "No catalogue record carries a subtype label this index selects on, so the file this run renders holds no rows. An index of nothing is not published over an index of something.",
    );
  }
  if (held === null) {
    return refuse(
      `Nothing has been generated at the index path in this workspace, so there is no file to publish to ${target.repo}.`,
    );
  }
  if (held !== generated) {
    return refuse(
      `The index held in this workspace is not what this catalogue generates, so publishing it would put a stale or hand-edited file on ${target.repo}. Regenerate it first.`,
    );
  }
  if (!remote.repoExists) {
    return refuse(
      `${target.repo} does not exist, or the token cannot see it. The repository is created once, by hand; this run publishes into it and does not make it.`,
    );
  }

  const branch = publicationBranch(target, remote);
  if (remote.branchCount > 0 && branch === null) {
    return refuse(
      `${target.repo} has branches but names no default, and ${BRANCH_ENV} is empty, so this run cannot tell which branch the index belongs on.`,
    );
  }
  if (remote.branchCount > 0 && !remote.branchExists) {
    return refuse(`${target.repo} has no branch ${branch}, so the index has nowhere to land on it.`);
  }
  if (remote.file === null) {
    return {
      action: "create",
      branch: remote.branchCount === 0 ? null : branch,
      sha: null,
      because: `${target.repo} publishes no ${target.path} yet, so this run writes the first one.`,
    };
  }
  if (remote.file.sha === "") {
    return refuse(
      `${target.repo} holds a ${target.path} that reports no blob sha, and an update without one would overwrite whatever is there blind.`,
    );
  }
  if (remote.file.content === generated) {
    return {
      action: "unchanged",
      branch,
      sha: remote.file.sha,
      because: `${target.repo} already publishes exactly what this catalogue generates, so this run writes no commit.`,
    };
  }
  return {
    action: "update",
    branch,
    sha: remote.file.sha,
    because: `${target.repo} publishes an index this catalogue no longer generates, so this run replaces it.`,
  };
}

export function publicationCommitMessage(census: ReadmeCensus): string {
  const records = `${census.rows} record${census.rows === 1 ? "" : "s"}`;
  return [
    `Regenerate from the free-tier catalogue — ${records}`,
    `${census.rated} rated`,
    `${census.withheld} publishing a reason instead of a rating`,
    `${census.withPriorTerms} showing the terms they replaced`,
  ].join(", ");
}
