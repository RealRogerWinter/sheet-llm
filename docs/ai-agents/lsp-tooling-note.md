---
title: LSP-First Code Navigation: Tooling Note
subsystem: cross-cutting
audience: [contributor, ai-agent]
status: current
last_verified: 2026-06-06
verified_against: 007e022
source_paths:
  - AGENTS.md
  - CLAUDE.md
related:
  - AGENT_GUIDE
---

# LSP-First Code Navigation: Tooling Note

A project note on how this repo nudges coding agents toward the LSP tool for
code navigation, and the Claude Code SessionStart hook that makes the preference
apply everywhere, not just inside this repo.

## Why this note exists

`AGENTS.md` already tells agents to prefer LSP over Grep/Read. But that guidance
only loads when an agent is working **inside a repo that ships it** (here, via
`CLAUDE.md` → `@AGENTS.md`). It also assumes the LSP tool is ready to call. In
Claude Code the `LSP` tool is **deferred**: its schema is not in context until
the agent loads it on demand with `ToolSearch`. So "prefer LSP" alone is a
no-op until the tool is loaded. An agent that never loads the schema falls back
to text search without realizing the better tool was one step away.

The SessionStart hook closes both gaps.

## Where the preference lives

| Layer | Scope | What it adds |
| --- | --- | --- |
| `AGENTS.md` (via `CLAUDE.md` → `@AGENTS.md`) | this repo only | The detailed rules: `workspaceSymbol` for definitions, `findReferences` for usages, check diagnostics after every edit |
| SessionStart hook (global `~/.claude/settings.json`) | every project | Extends the default to repos with no `AGENTS.md`, and reminds the agent to load the LSP schema first |

The two layers do different jobs. `AGENTS.md` holds the rich, repo-specific
guidance; the hook carries the minimum global default plus the one step
`AGENTS.md` omits: loading the tool.

## The SessionStart hook

Added to the user's global `~/.claude/settings.json` (not committed to this
repo; it configures the agent's environment, not the product):

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "echo '{\"hookSpecificOutput\":{\"hookEventName\":\"SessionStart\",\"additionalContext\":\"CODE NAVIGATION DEFAULT: A TypeScript LSP tool is available (typescript-lsp plugin, ENABLE_LSP_TOOL=1). For any task that reads or navigates code in an LSP-supported project, PREFER the LSP tool (go-to-definition, find-references, hover, document/workspace symbols, rename) over Grep/Read or bash grep/sed. As your first step in such work, load its schema once via ToolSearch with query select:LSP, then use it instead of text search. Fall back to Grep/Read only when LSP cannot answer (non-code files, languages the server does not cover).\"}}'"
          }
        ]
      }
    ]
  }
}
```

On each new session the hook injects that text into the agent's context. The
agent reads it, loads the LSP schema with `ToolSearch select:LSP`, and reaches
for LSP before text search.

### Prerequisites

The hook assumes the LSP tool is enabled. In this environment that is already
true:

- `typescript-lsp@claude-plugins-official` is an enabled plugin
- `ENABLE_LSP_TOOL=1` is set in `env`

The hook neither installs nor enables the tool. Claude Code has no setting that
pins a deferred tool as always-loaded, so the hook instructs the agent to load
it instead.

### When it takes effect

SessionStart hooks fire only at the start of a session, so the change applies
to the **next** session, not the one that edits the settings file. Review or
disable it anytime with `/hooks`.

## See also

- `AGENTS.md`: the repo-level LSP rules
- [`AGENT_GUIDE.md`](AGENT_GUIDE.md): agent orientation for this codebase
