# Plan: Loom-as-Agent-Tool

## Context
JARVIS currently requires explicit `workflow:` field in task requests to invoke Loom workflows. The agent cannot autonomously discover, select, or invoke workflows. This limits the agent's ability to choose the best execution strategy for a given task.

## Work Objectives
Expose Loom workflows as SDK custom tools so the agent can autonomously decide when and which workflow to use.

## Guardrails
**Must Have**:
- 3 custom tools: `loom_list`, `loom_run`, `loom_status`
- Backward compatibility: explicit `task.workflow` still works
- Security: workflow paths constrained to WORKFLOWS_DIR
- All existing tests pass

**Must NOT Have**:
- New processes or MCP servers (in-process only)
- Architecture redesign of loom.ts or warm-pool.ts
- Breaking changes to TaskRequest interface

## Task Flow

### Step 1: Create `src/core/loom-tools.ts`
New module with tool definitions, workflow catalog builder, and handler functions.
- **Acceptance**: `getLoomToolDefinitions()` returns valid schemas; `handleLoomRun()` calls `runWorkflow()`; unit tests pass.

### Step 2: Integrate into SDK Runner and Warm Pool
Modify `sdk-runner.ts` and `warm-pool.ts` to register loom tools in `query()` and handle tool_use events.
- **Acceptance**: Agent sees loom tools; workflow execution works end-to-end; existing tools unaffected; build passes.

### Step 3: Create Loom Orchestrator Skill
New `skills/loom-orchestrator/SKILL.md` with decision matrix for when to use workflows.
- **Acceptance**: Skill parses correctly; under 500 words; covers all existing workflows.

### Step 4: Backward Compatibility in jarvis.ts
Keep explicit `task.workflow` routing; auto-load loom-orchestrator skill when no workflow specified.
- **Acceptance**: Explicit workflow routing unchanged; tests green.

### Step 5: Unit Tests
New `tests/unit/loom-tools.test.ts` covering catalog builder, handlers, tool definitions.
- **Acceptance**: All tests pass; mocked dependencies; no flaky tests.

## Success Criteria
- Agent can call `loom_list` and see available workflows
- Agent can call `loom_run("code-impl", {prompt: "fix bug", repo: "user/repo"})` and get results
- Existing `task.workflow = "code-impl.loom"` behavior unchanged
- `npm run build` and `npm test` pass
- No new processes spawned

## Openspec Files
Written to: `/Users/moonseokhoon/Desktop/project/jarvis/openspec/changes/loom-as-agent-tool/`
- `proposal.md` -- Problem statement + 5-role design session consensus
- `design.md` -- Architecture, data flow, security model, ADR
- `tasks.md` -- 5 implementation tasks with acceptance criteria
