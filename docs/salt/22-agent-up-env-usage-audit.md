# Agent-Up Environment Usage Audit

Date: 2026-06-20
Scope: `bin/agent-up`, `remote/bin/agent-up`, `bin/agent-up-v1`, MCP subprocess env, per-agent launch env, Codex `-c` MCP overrides, v1 Claude subconscious hook env.

This is an implementation audit, not user-facing README material. The question was whether each generated env var is actually consumed by the system, and whether it remains useful on the normal generated startup path.

## Normal Startup Assumption

The normal managed MCP path sets:

- `AGENT_NAME`
- `AGENT_CHAT_API`
- `API_TOKEN`
- `AGENTCHAT_AGENT_STATE_DIR` for v1/managed agent homes

Under that path, several older fallback env vars are still accepted by code but do not change behavior.

## Findings

| Env var | Status | Evidence | Current usefulness |
| --- | --- | --- | --- |
| `AGENT_NAME` | Required | Written by `agent-up` into launch env, Claude MCP env, and Codex MCP overrides. Read first by `lib/mcp-server-core.js` in `detectAgentName()`, then used for registration, heartbeat, inbox, send/post, tasks, pid file, and media cache naming. | Required. Without it, MCP falls back to tmux/tty heuristics and may fail outside a recognizable tmux pane. |
| `AGENT_CHAT_API` | Required | Computed by `agent-up` from explicit API or backend port fallback, then written into MCP/Codex env. Read by `lib/mcp-server-core.js`, `bridge-matrix.js`, `lib/push-relay-core.js`, and v1 subconscious setup. | Required for non-default and managed deployments. It is the canonical backend endpoint. |
| `API_TOKEN` | Required in authenticated deployments | Written into launch env and Codex MCP overrides. MCP sends it as bearer auth; bridge/push relay/backend helpers also read it. Backend startup/auth paths use `API_TOKEN` for operator bearer compatibility. | Required when backend auth is enabled. Per-agent tokens may cover some MCP routes, but bearer compatibility is still real code behavior. |
| `AGENTCHAT_AGENT_STATE_DIR` | Required for v1/managed homes | Written for v1 launch env and MCP/Codex env when state dir exists. MCP reads it for per-agent token, media cache, derived state dir, and pid file. Claude subconscious hook reads it for state paths. | Required for v1/managed agents. It is the correct way for MCP to find agent-local state. |
| `AGENT_CHAT_SERVER` | Conditional | Written only when configured. Read through `lib/server-identity.js`; MCP heartbeat includes it in backend runtime state. | Required on remote/runtime-host deployments where hostname fallback is not the intended server id. Optional on simple local setups. |
| `AGENT_CHAT_BACKEND_PORT` | Redundant when `AGENT_CHAT_API` is set | Written into MCP/Codex env. MCP, bridge, backend scripts, and setup scripts read it only to build `http://127.0.0.1:<port>` when `AGENT_CHAT_API` is absent. | Safe fallback, but redundant on generated MCP configs that already set `AGENT_CHAT_API`. |
| `AGENT_CHAT_RUNTIME_DIR` | Redundant for MCP when state dir is set | Written into MCP/Codex env. MCP uses it only for media-cache fallback after `AGENTCHAT_AGENT_STATE_DIR`. Backend/bridge services read their own service env, not the agent MCP env. | Useful for service processes and legacy fallback. Redundant in per-agent MCP env when state dir is present. |
| `AGENTCHAT_HOMEDIR` | Redundant for MCP when state dir is set | Written if inherited. MCP uses it only as fallback after `AGENTCHAT_AGENT_STATE_DIR`; `agent-ls`, `agent-maintain`, project/resume helpers also read it as a home root. | Useful for CLI/home discovery. Redundant in per-agent MCP env when state dir is present. |
| `AGENT_CHAT_MCP_SERVER_NAME` | Generated but unused as env | `agent-up` uses the value to choose the Claude `.mcp.json` server key. The MCP server itself does not read this env; its advertised runtime name is `agent-chat-${AGENT_NAME}`. Codex uses hardcoded MCP config key `agent-chat`. | The config key is useful; exporting the same value as an env var is dead. |
| Bulk `AGENT_CHAT_*` launch env copy | Conditional | `agent-up` copies all current `AGENT_CHAT_*` names into `launch-env.sh`. Some names are real for launched tools/services; arbitrary inherited names are not necessarily consumed. | Too broad as a launch contract. Known envs should be explicit; unknown bulk copy is compatibility baggage. |
| `AGENTCHAT_SUBCONSCIOUS_EVENT_URL`, `AGENTCHAT_SUBCONSCIOUS_INVOKE_URL`, `AGENTCHAT_SUBCONSCIOUS_ENABLED` | Conditional | Written only for v1 agents. Read by `subconscious/claude-agentchat/scripts/hook-entry.mjs`. | Useful only for Claude v1 subconscious hooks. |
| `AGENTCHAT_LETTA_STATE_FILE` | Redundant with normal state dir | Written for v1 launch env. Hook can read it, but otherwise derives `letta.json` from `AGENTCHAT_AGENT_STATE_DIR`. | Redundant when state dir layout is normal. |
| `AGENTCHAT_AGENT_ID`, `LETTA_AGENT_ID` | Conditional | Written for v1 launch/hook state. Hook and setup code read them for stable Letta/subconscious identity. | Useful only for v1 subconscious identity. |
| `AGENTCHAT_SUBCONSCIOUS_PLUGIN_ROOT` | Generated but currently unused by hook | Written for v1 launch env. Current hook command uses Claude's `${CLAUDE_PLUGIN_ROOT}` path from hooks config; focused production code did not read this env. | Dead unless a future hook script starts reading it. |
| `ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY` | Conditional external runtime env | Written from primary runtime profile. The repo mostly passes them through; the external Claude runtime consumes them. | Useful only for custom Anthropic-compatible Claude runtime profiles. Not useful for Codex. |
| `SUPERVISOR_LLM_PROVIDER`, `SUPERVISOR_LLM_MODEL`, `AGENTCHAT_SUPERVISOR_REASONING_PROFILE`, `AGENTCHAT_SUPERVISOR_FRAMEWORK`, `AGENTCHAT_SUPERVISOR_EXTRA_ARGS` | Conditional | Written from supervisor runtime profile. `lib/supervisor-lifecycle-manager.js` reads them when selecting and launching supervisor runtime. | Useful only when supervisor lifecycle is launched under this env. |
| `AGENTCHAT_RUNTIME_PROFILE_PRIMARY_JSON`, `AGENTCHAT_RUNTIME_PROFILE_SUPERVISOR_JSON` | Generated but no direct primary reader found | Written from metadata. Supervisor launch command re-exports primary JSON, but focused code does not parse it as an input contract. | Not a proven useful env contract today. Keep only if a downstream runtime explicitly consumes it. |
| `AGENTCHAT_AGENT_MODEL_VERSION`, `AGENTCHAT_AGENT_HOME`, `AGENTCHAT_AGENT_WORKDIR` | Generated but no focused production reader found | Written for v1 launch env. Current focused runtime paths use `AGENTCHAT_AGENT_STATE_DIR`, meta files, and hook env instead. | Not proven useful today. |

## Normal MCP Path Reduction

If `AGENT_CHAT_API` and `AGENTCHAT_AGENT_STATE_DIR` are both set, the normal MCP subprocess does not need:

- `AGENT_CHAT_BACKEND_PORT`
- `AGENT_CHAT_RUNTIME_DIR`
- `AGENTCHAT_HOMEDIR`
- `AGENTCHAT_LETTA_STATE_FILE`
- `AGENT_CHAT_MCP_SERVER_NAME` as an env var

The config server key named by `AGENT_CHAT_MCP_SERVER_NAME` is separate from the env var and still matters for Claude `.mcp.json` discovery.

## Design Implication

The current startup path mixes four different contracts in one env blob:

1. MCP identity and backend auth.
2. Service/backend/bridge runtime settings.
3. v1 Claude subconscious hook settings.
4. External model-provider settings.

The next cleanup should stop exporting broad env inheritance into per-agent MCP processes. A safer shape is:

- generate a minimal MCP env from a named allowlist;
- keep external model-provider env only in the actual Claude/Codex launch wrapper;
- keep v1 subconscious env only when hooks are enabled;
- remove dead generated envs after one compatibility release or after operator confirmation.
