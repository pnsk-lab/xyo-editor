---
name: fix-pr-and-merge
description: Implement a requested fix, create a branch and pull request, and merge it after CI succeeds. Use when the user asks for the complete fix-to-merge workflow.
---

# Fix, PR, and merge

Carry the requested fix through to a merged pull request. The user's invocation authorizes the branch, push, PR creation, and merge for that fix, subject to repository rules and higher-priority instructions.

1. Inspect repository instructions, working-tree state, the target branch, and the reported issue. Preserve unrelated work; use an appropriately named branch based on the target branch.
2. Implement the fix and run relevant local checks. Commit only the intended changes, push the branch, and open a PR against the appropriate target. Explain the problem, fix, and validation in the PR.
3. Check the PR's actual CI and required review/merge status. Investigate and fix failures caused by the change, push updates, and wait for the checks on the latest commit. Follow the environment's PR tracking and waiting instructions when available.
4. Merge only after required checks pass and repository requirements are satisfied. Respect the repository's merge method and branch protection; do not bypass protections or merge with failing or pending required checks. If CI is absent or its status is ambiguous, or an external dependency or required approval blocks merging, report the blocker rather than claiming success.
5. Report the PR link, validation, and merge outcome. Do not delete branches or perform unrelated cleanup unless requested or required by repository convention.
