---
name: plan
description: Plan a feature with an optional repository explorer and interactive planner, then delegate scoped implementation and independent review inside Herdr.
---

# Plan

Read repository instructions and establish the user's intended behavior. Use the smallest sufficient workflow. Do not force planning ceremonies on an already scoped change.

1. If repository context is missing, delegate to subagent-explorer. Ask for relevant files, callers, current behavior, constraints and checks. Read-only explorers return findings; the parent writes shared context only when it needs to persist.
2. For interactive design, launch planner with the user's request and relevant explorer findings. Give an explicit plan path when a saved plan is useful. Keep the existing planner workflow available; do not require it for routine implementation.
3. Review the resulting scope and acceptance criteria. Clarify only decisions that materially affect implementation. Continue implementation when already authorized; otherwise obtain authorization for the concrete plan.
4. Assign scoped changes to subagent-worker. Include requirements, owned files, evidence, baseline, and checks. For bugs pass skills: "diagnosing-bugs". The parent manages any todos; do not assume workers have a todo tool. Workers run relevant checks before returning.
5. Delegate independent review to subagent-reviewer with the exact baseline or manifest and task requirements. Include uncommitted work and task-owned untracked files. Reviewers return findings; the parent writes a review artifact only when needed.
6. Add subagent-tester for additional verification and subagent-quality for meaningful complexity. Quality improvements alone do not block completion. Repository audits use skills: "ponytail-audit" and an explicit broader scope.
7. Resume the original worker for required fixes. Rerun only affected checks/review. After three unsuccessful cycles, report the unresolved evidence rather than looping.
8. Review the final diff, stage only task-related changes, create the local commit required by repository/user instructions, and report its hash. Never push unless explicitly instructed.

Examples:

```typescript
subagent({ name: "Explore", agent: "subagent-explorer", task: "Map the relevant callers and verification commands for ..." });
subagent({ name: "Planner", agent: "planner", interactive: true, task: "Plan ... using this evidence: ..." });
subagent({ name: "Implement", agent: "subagent-worker", task: "Implement ...; scope ...; verify ..." });
subagent({ name: "Review", agent: "subagent-reviewer", task: "Review ... against ...; include task-owned working-tree changes." });
```

Keep writers sequential in a shared checkout. Use worktree: true for independent lanes when appropriate, then follow manifest review and handoff rules. Let the extension deliver results; do not poll. Do not rename the parent workspace/tab as part of this workflow.
