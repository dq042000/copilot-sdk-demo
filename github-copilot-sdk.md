# Research Report: `github/copilot-sdk`

Repository researched: `https://github.com/github/copilot-sdk`  
Primary evidence base: local clone at commit `1dba08d1aca531f0980b0156b4950d74fd26f028`

## Executive summary

`github/copilot-sdk` is a multi-language SDK monorepo that lets an application embed the same agent runtime used by Copilot CLI instead of building its own planner, tool router, and session manager. The repository currently publishes official SDKs for Node.js/TypeScript, Python, Go, and .NET, and the basic architecture is intentionally thin: your app talks to an SDK client, the SDK speaks JSON-RPC to Copilot CLI in headless/server mode, and the CLI talks onward to GitHub Copilot or a configured model provider.[^1]

The important practical takeaway is that this is not a toy wrapper. Even though the README still labels the project as **Technical Preview** and explicitly warns it may not yet be production-ready, the docs and code already cover serious deployment concerns: local development, bundled distribution, backend-service topologies, multi-tenant scaling patterns, OpenTelemetry, persistent sessions, MCP integration, custom agents, custom skills, and BYOK provider configuration.[^1][^5][^8][^9][^10][^28]

My overall read is: **feature-rich preview, architecturally coherent, cross-language parity is strong, but the dependency on Copilot CLI and the preview label mean you should treat it as an evolving integration surface rather than a stable GA platform**.[^1][^2][^24][^27]

## What the project is

The repo is organized as a language-parity monorepo. The root README lists four official SDKs:

- `nodejs/` for Node.js / TypeScript
- `python/`
- `go/`
- `dotnet/`

The same README also makes two strategic points that explain most design choices in the codebase:

1. all SDKs communicate with Copilot CLI over JSON-RPC, and  
2. the CLI is the actual agent runtime boundary, not the SDK itself.[^1]

That design explains why the SDKs look similar even though their host languages differ. Their job is mostly to:

- manage CLI process lifecycle or connect to an already-running CLI server,
- translate language-native configs into JSON-RPC session/create/send/resume requests,
- register host-language callbacks for tools, permissions, hooks, and user input,
- expose event streams and convenience APIs like `sendAndWait`, and
- carry trace/auth/provider settings into the CLI process.[^1][^3][^4]

## Architecture and runtime model

At a high level, the repository’s architecture is:

```text
Your application
    |
SDK client (Node / Python / Go / .NET)
    |
JSON-RPC over stdio or TCP
    |
Copilot CLI (--stdio or --headless)
    |
GitHub Copilot or configured model provider
```

That diagram is stated directly in the root README, and the setup docs expand it into three main deployment shapes:

- **local auto-managed CLI**: simplest path; the SDK spawns a local child process and typically talks over stdio,
- **bundled CLI**: your application ships a known CLI binary and points the SDK at it with `cliPath`,
- **external/headless CLI server**: the SDK connects over TCP to a separately managed `copilot --headless` process using `cliUrl`.[^1][^8][^9][^10]

The runtime boundary matters because not every Copilot CLI feature is necessarily available in the SDK. The compatibility doc is explicit that the SDK can only use features exposed through the CLI’s JSON-RPC protocol, and it lists several CLI-only/TUI-only features that are intentionally out of scope for SDK consumers, such as slash-command UX, deep-research TUI workflows, and certain rendering-oriented terminal features.[^2]

## Protocol versioning and compatibility

The repository root pins the current SDK protocol version to `3`, while the compatibility guide says the SDK supports protocol versions **2 through 3**. The same guide also states that connecting to a v2 CLI is supported through automatic adapters for older `tool.call` and `permission.request` semantics.[^2]

The Node client source confirms this in implementation detail. It always registers compatibility handlers for legacy `tool.call` and `permission.request` requests, while also supporting v3-style event-driven broadcasts such as `external_tool.requested` and `permission.requested`. This is a good sign: compatibility is not just claimed in docs, it is wired directly into startup behavior.[^2][^18]

This protocol story is also echoed in the changelog:

- `v0.1.32` added explicit backward compatibility with v2 CLI servers,
- `v0.1.31` described the move to protocol v3 broadcasts for multi-client tool and permission scenarios.[^24]

In other words, the protocol is still evolving, but it is evolving in a way that tries to preserve app code across CLI upgrades and mixed-version environments.[^2][^24]

## Shared behavioral model across SDKs

Across all four SDKs, the session model is almost the same:

- `createSession` / `create_session` / `CreateSession` / `CreateSessionAsync`
- `send` plus a blocking convenience wrapper `sendAndWait`
- event subscription for session events and streamed deltas
- callbacks for permissions, user-input requests, and hooks
- support for resume/delete/list-style session lifecycle operations.[^2][^4]

The `sendAndWait` implementations are notably similar in all languages. Each one:

1. registers an event handler before sending a prompt,
2. tracks the latest `assistant.message`,
3. resolves when `session.idle` arrives,
4. rejects or errors on `session.error`, and
5. treats timeout as a client-side waiting bound rather than an abort of agent work.[^4]

That consistency is a strong parity signal. It means higher-level product behavior should feel the same no matter which host language you choose, even if the ergonomics differ.[^4]

## Permission handling is effectively mandatory

One subtle but important design choice: **permission handling is not optional in practice**.

All four SDKs explicitly reject session creation if no permission handler is provided:

- Node throws unless `onPermissionRequest` is supplied,
- Python raises `ValueError` unless `on_permission_request` is present,
- Go returns an error unless `OnPermissionRequest` is set,
- .NET throws unless `OnPermissionRequest` is non-null.[^18][^19][^20][^21]

This is a meaningful API choice. It forces the embedding application to make an explicit trust decision instead of silently inheriting broad defaults. That matters because the README also notes that the CLI side can expose powerful built-in tools for filesystem, git, and web operations.[^1]

## Authentication model

The authentication docs present four core auth families:

- signed-in GitHub user credentials from prior CLI login,
- OAuth GitHub App tokens,
- environment-variable tokens,
- BYOK provider credentials.[^5]

The auth priority order is also clearly documented:

1. explicit `githubToken`,
2. HMAC key,
3. direct API token + API URL,
4. environment variable tokens,
5. stored CLI OAuth credentials,
6. GitHub CLI credentials.[^5]

This priority chain is important operationally because it means an application can move from local development to CI or hosted infrastructure without redesigning the auth model; it mostly changes which layer supplies credentials.[^5]

The code also imposes a clean separation when using an external CLI server. Node, Go, and .NET clients all explicitly reject combinations like `cliUrl` plus local auth options such as `githubToken` or `UseLoggedInUser`, because the external server is expected to manage its own authentication context.[^18][^20][^21]

## BYOK and provider flexibility

BYOK is one of the strongest signs that this repo is intended for real embedded use cases rather than only personal scripting. The docs support:

- OpenAI,
- Azure OpenAI / Azure AI Foundry,
- Anthropic,
- OpenAI-compatible endpoints such as Ollama, Foundry Local, vLLM, or LiteLLM.[^6]

The session config surfaces in Node and Python expose a first-class `provider` config, and Python’s provider type explicitly includes both `api_key` and `bearer_token`, with `bearer_token` taking precedence when both exist.[^17][^19]

There is, however, an important limitation. The README says BYOK is key-based only and does not natively support Microsoft Entra ID / managed identities. The repo compensates with a documented Azure Managed Identity pattern: obtain a short-lived bearer token with `DefaultAzureCredential` and pass it via `bearer_token` in provider config.[^1][^7]

So the right mental model is: **BYOK is flexible, but identity-provider-native auth is still partially manual today**.[^1][^6][^7]

## Deployment patterns

The repo’s setup docs map cleanly to three different product types:

### 1. Local development / prototyping

The “Local CLI Setup” guide is the lowest-friction route: install Copilot CLI once, sign in once, and let the SDK spawn the CLI as a child process using stored keychain credentials, usually over stdio.[^8]

This is the best fit for prototypes, internal tools, and local developer workflows.[^8]

### 2. Bundled applications

The “Bundled CLI Setup” guide shows how to ship a known CLI binary with the app and point the SDK at it using `cliPath`. The docs explicitly position this for desktop apps, Electron apps, standalone tools, and distributable utilities, with auth options ranging from inherited CLI login to environment variables to full BYOK.[^10]

This pattern is especially interesting because it lets an application control the exact CLI version it depends on, which is a useful mitigation for a preview-stage ecosystem.[^10]

### 3. Backend services and multi-tenant systems

The “Backend Services Setup” and “Scaling & Multi-Tenancy” guides are the strongest evidence that GitHub expects hosted/server use cases. They describe running the CLI independently in `--headless` mode, connecting via `cliUrl`, sharing or isolating CLI servers, and choosing scaling patterns around three dimensions: isolation, concurrency, and persistence.[^9][^10]

The scaling guide explicitly contrasts:

- isolated CLI per user, for strongest isolation,
- shared CLI with isolated sessions, for lighter resource usage,
- and broader multi-user deployment tradeoffs.[^10]

That is far beyond “hello world” documentation; it is the architecture advice of a platform that expects real deployment pressure.[^9][^10]

## Feature surface

The SDK-compatible feature set is broad. The compatibility guide and feature docs together show first-class support for:

- session creation/resume/list/delete,
- message sending with attachments,
- streaming deltas,
- custom tools,
- permission control,
- hooks,
- MCP servers,
- custom agents,
- skills,
- custom system messages,
- model selection and mid-session switching,
- reasoning effort,
- infinite sessions / compaction,
- telemetry and trace propagation.[^2][^3][^15][^16][^17][^28]

Some highlights:

### Streaming

Streaming is enabled per session and emits `assistant.message_delta` chunks before the final message. The getting-started guide walks through streaming in multiple languages, and each SDK’s `sendAndWait` implementation still preserves event delivery during the wait cycle.[^3][^4]

### Custom tools

Tool support is central, not bolted on. The getting-started guide treats tools as the main “powerful part,” and the language implementations all provide helper APIs for turning host-language function definitions into JSON-schema-backed tool declarations.[^3][^17][^19][^20][^21]

### Hooks

Hooks cover the full session lifecycle, not just tools: pre-tool, post-tool, user-prompt submission, session start/end, and error handling. The pre-tool hook can allow/deny/ask, modify args, add context, and suppress output. The error hook can retry, skip, abort, suppress output, or provide a user-facing notification.[^16]

### MCP

MCP is treated as a first-class integration mechanism with support for both local/stdin-stdout subprocess servers and remote HTTP/SSE servers. The docs explicitly call out the GitHub MCP server as a standard way to expose repo/issues/PR capabilities to agents.[^11][^28]

### Custom agents and sub-agent orchestration

Custom agents are not just static prompts. The docs describe them as scoped agent definitions that the runtime can auto-select and delegate to as sub-agents within a parent session, each with its own tool restrictions and optional MCP servers.[^12]

### Skills

Skills are directory-based prompt modules: a named folder with `SKILL.md` whose contents are injected into session context. This is a lightweight but powerful composition model for reusable domain instructions.[^13]

### Persistent sessions and infinite sessions

The session-persistence docs explain resumable sessions keyed by caller-supplied `session_id`, and the Go types plus compaction tests show that the SDK also exposes “infinite sessions” with automatic compaction thresholds and workspace persistence.[^14][^20][^23]

### Steering and queueing

The steering/queueing guide is unusually precise about delivery semantics:

- `"enqueue"` is the default and buffers work for the next full turn,
- `"immediate"` attempts to inject a message into the current turn,
- if steering arrives too late, it is moved to the next-turn queue,
- when the session is idle, both modes behave the same.[^15]

That level of specificity is valuable if you are building interactive UI around an agent rather than just firing one-shot prompts.[^15]

### Telemetry

Telemetry is an opt-in client config that enables OpenTelemetry trace export from the CLI process and automatic W3C trace-context propagation between SDK and CLI. The docs show parity across all four languages, and the client implementations literally translate telemetry settings into environment variables like `COPILOT_OTEL_ENABLED`, `OTEL_EXPORTER_OTLP_ENDPOINT`, and file-export options before launching the CLI.[^18][^19][^20][^21][^28]

## Language-by-language assessment

### Node.js / TypeScript

The Node SDK feels like the reference implementation for JavaScript ecosystems. It exposes:

- raw JSON Schema or Zod-like schemas via `defineTool`,
- first-class session config for provider/MCP/agents/skills/hooks,
- explicit runtime compatibility adapters for v2 protocol servers,
- and an extra `@github/copilot-sdk/extension` entrypoint with `joinSession()` for child-process extensions that want to attach to the foreground Copilot session.[^17][^18][^22]

Two things stand out:

1. it is especially ergonomic for frontend-adjacent or Electron-like stacks because the API surface is idiomatic JS/TS, and  
2. it appears to be where new protocol mechanics are easiest to inspect because the JSON-RPC wiring is very transparent in source.[^17][^18][^22]

### Python

The Python SDK is strongly async-first. Its biggest ergonomic differentiator is `define_tool`, which can infer JSON Schema from Pydantic models and can be used as either a decorator or a factory function. That makes Python probably the nicest experience for teams already comfortable with FastAPI/Pydantic-style modeling.[^19]

The Python types also expose a broad, fairly complete `TypedDict` session config, including provider settings, user input, hooks, skills, MCP, agents, reasoning effort, and infinite sessions. The client startup code shows the same core architecture as Node: spawn a subprocess by default, or connect externally, and translate telemetry settings into CLI environment variables.[^19]

### Go

The Go SDK is the most explicit and infrastructure-oriented of the four:

- `context.Context` is threaded through client/session operations,
- `DefineTool` is generic and uses `google/jsonschema-go/jsonschema`,
- session/tool structs are strongly typed but more verbose,
- trace context is passed into tool invocations as a `context.Context`,
- and concurrency semantics are visible and unsurprising.[^20]

This makes Go a good fit for backend services and platform teams that want type clarity, structured control, and straightforward integration with observability stacks, even if it is less terse than Python or Node.[^20]

### .NET

The .NET SDK is the most framework-integrated. Its session config uses `ICollection<AIFunction>` for tools, which ties it naturally into `Microsoft.Extensions.AI`, and its permission/user-input/hook model is expressed through typed delegates and classes instead of maps or loosely typed objects.[^21]

The .NET client also has good operational polish:

- clean `CreateSessionAsync` validation,
- explicit process-start configuration,
- OpenTelemetry wiring with `System.Diagnostics.Activity`,
- and strong typing around session/resume config.[^21][^28]

If your application already lives in ASP.NET or the wider Microsoft extension ecosystem, .NET likely offers the smoothest “native” integration path.[^21]

## Cross-language parity: what is truly shared vs what differs

### Shared well across all four SDKs

The following look genuinely cross-language rather than “documented but uneven”:

- session lifecycle,
- streaming,
- custom tools,
- permission handlers,
- ask-user callbacks,
- hooks,
- MCP server config,
- custom agents,
- skills,
- resumable sessions,
- telemetry,
- reasoning effort,
- model switching and session RPC surface.[^2][^3][^4][^17][^19][^20][^21][^24]

### Main differences

The differences are mostly ergonomic, not conceptual:

- **Node**: most flexible for raw JSON Schema and JS-native extension composition.[^17][^22]
- **Python**: best schema ergonomics through Pydantic/decorator patterns.[^19]
- **Go**: most explicit and infra-friendly; strongest fit for context-heavy server code.[^20]
- **.NET**: richest static typing and strongest integration with Microsoft AI abstractions.[^21]

So if you are choosing a language, choose based on host-ecosystem fit, not missing features. The repo is clearly trying to make the feature set converge.[^24][^27]

## Evidence of maturity

There are two competing signals in this repository, and both are real.

### Signal 1: still preview

The README explicitly says the SDK is in **Technical Preview** and may not yet be suitable for production use.[^1]

### Signal 2: already quite mature in scope

Against that warning, the repo shows several maturity indicators:

- detailed setup docs for local, bundled, backend, and scaling deployments,[^8][^9][^10]
- compatibility documentation that clearly distinguishes SDK vs CLI-only features,[^2]
- fairly deep hooks/skills/agents/MCP docs rather than only basic samples,[^11][^12][^13][^16]
- strong parity-focused changelog entries across languages,[^24]
- and e2e tests in Go, Python, and .NET that explicitly exercise ask-user, hooks, MCP/custom agents, skills, streaming fidelity, and compaction.[^23][^25][^26]

That combination suggests the preview label is less about “missing fundamentals” and more about “protocol and API surface still moving.”[^2][^24]

## Recent evolution

Recent released changes show a project that is still actively closing parity gaps and hardening protocol behavior:

- `v0.1.32`: v2 CLI compatibility,
- `v0.1.31`: protocol v3 multi-client broadcasts and typed permission result constants for Go/.NET,
- `v0.1.30`: override built-in tools and simpler mid-session model switching.[^24]

The most recent local commits continue the same pattern:

- Python typing improvements for `CopilotClient.on()`,
- updated Python signatures for `send()` / `send_and_wait()`,
- telemetry installation-instruction updates,
- reasoning-effort support across SDKs.[^27]

That commit mix is revealing. The project is not just adding flashy features; it is also sanding down host-language ergonomics, documentation, and parity details. That is usually a healthy sign in an SDK at this stage.[^24][^27]

## Strengths

- Clear and consistent architecture: SDK as host-language bridge, CLI as agent runtime.[^1]
- Strong cross-language parity on core concepts.[^2][^4][^24]
- Serious embedded-app capabilities: tools, hooks, MCP, agents, skills, persistence, telemetry.[^11][^12][^13][^14][^16][^28]
- Good deployment guidance for real products, especially backend and multi-tenant scenarios.[^9][^10]
- Practical compatibility stance with protocol adaptation instead of forcing immediate rewrites.[^2][^18][^24]

## Limitations and risks

- Technical Preview label means surface stability is not guaranteed.[^1]
- SDK capability is constrained by what Copilot CLI exposes over JSON-RPC; not all CLI/TUI features are available programmatically.[^2]
- External-server mode has strict auth-boundary assumptions that may surprise developers expecting to override auth from the client side.[^18][^20][^21]
- Operationally, you are depending on both the SDK package and the CLI runtime, not just a single library artifact.[^1][^8][^9][^10]

## Bottom line

`github/copilot-sdk` is best understood as **an application-embedding layer for Copilot CLI’s agent runtime**. If you want to put a capable, tool-using Copilot agent inside your own product without inventing orchestration from scratch, this repo already gives you a surprisingly complete foundation. The main tradeoff is maturity: it is powerful enough for serious experimentation and likely some controlled production pilots, but the repository itself still says you should expect movement in API/protocol details.[^1][^24]

If I were making a decision today:

- I would treat it as a strong choice for prototypes, internal platforms, and preview-stage embedded-agent products.
- I would be comfortable investing in it for backend or desktop architectures that can tolerate a fast-moving dependency.
- I would avoid assuming full long-term stability until the project drops the preview label and the protocol surface settles further.[^1][^9][^10][^24]

## Confidence assessment

High confidence:

- overall architecture,
- feature inventory,
- auth/deployment patterns,
- parity across languages,
- maturity trajectory.[^1][^2][^5][^9][^24]

Moderate confidence:

- production readiness in practice, because I did not benchmark runtime behavior or operate a long-lived service with the SDK; this report is source- and doc-driven rather than performance-driven.[^1][^9][^10]

## Footnotes

[^1]: `/home/dq042000/.copilot/session-state/8834211e-10a5-4031-aeca-eee7972c730b/files/copilot-sdk/README.md`:15-22, 40-52, 56-78, 80-90, 101-108 (commit `1dba08d1aca531f0980b0156b4950d74fd26f028`).

[^2]: `/home/dq042000/.copilot/session-state/8834211e-10a5-4031-aeca-eee7972c730b/files/copilot-sdk/sdk-protocol-version.json`:1-3; `/home/dq042000/.copilot/session-state/8834211e-10a5-4031-aeca-eee7972c730b/files/copilot-sdk/docs/troubleshooting/compatibility.md`:1-33, 34-90, 91-120, 269-276 (commit `1dba08d1aca531f0980b0156b4950d74fd26f028`).

[^3]: `/home/dq042000/.copilot/session-state/8834211e-10a5-4031-aeca-eee7972c730b/files/copilot-sdk/docs/getting-started.md`:95-140, 238-300, 594-647, 1218-1300 (commit `1dba08d1aca531f0980b0156b4950d74fd26f028`).

[^4]: `/home/dq042000/.copilot/session-state/8834211e-10a5-4031-aeca-eee7972c730b/files/copilot-sdk/nodejs/src/session.ts`:131-218; `/home/dq042000/.copilot/session-state/8834211e-10a5-4031-aeca-eee7972c730b/files/copilot-sdk/python/copilot/session.py`:119-225; `/home/dq042000/.copilot/session-state/8834211e-10a5-4031-aeca-eee7972c730b/files/copilot-sdk/go/session.go`:121-224; `/home/dq042000/.copilot/session-state/8834211e-10a5-4031-aeca-eee7972c730b/files/copilot-sdk/dotnet/src/Session.cs`:153-240 (commit `1dba08d1aca531f0980b0156b4950d74fd26f028`).

[^5]: `/home/dq042000/.copilot/session-state/8834211e-10a5-4031-aeca-eee7972c730b/files/copilot-sdk/docs/auth/index.md`:1-13, 205-279 (commit `1dba08d1aca531f0980b0156b4950d74fd26f028`).

[^6]: `/home/dq042000/.copilot/session-state/8834211e-10a5-4031-aeca-eee7972c730b/files/copilot-sdk/docs/auth/byok.md`:1-15, 16-44, 65-90, 115-120 (commit `1dba08d1aca531f0980b0156b4950d74fd26f028`).

[^7]: `/home/dq042000/.copilot/session-state/8834211e-10a5-4031-aeca-eee7972c730b/files/copilot-sdk/docs/setup/azure-managed-identity.md`:1-13, 22-27 (commit `1dba08d1aca531f0980b0156b4950d74fd26f028`).

[^8]: `/home/dq042000/.copilot/session-state/8834211e-10a5-4031-aeca-eee7972c730b/files/copilot-sdk/docs/setup/local-cli.md`:1-27, 29-60 (commit `1dba08d1aca531f0980b0156b4950d74fd26f028`).

[^9]: `/home/dq042000/.copilot/session-state/8834211e-10a5-4031-aeca-eee7972c730b/files/copilot-sdk/docs/setup/backend-services.md`:1-38, 39-55, 57-120 (commit `1dba08d1aca531f0980b0156b4950d74fd26f028`).

[^10]: `/home/dq042000/.copilot/session-state/8834211e-10a5-4031-aeca-eee7972c730b/files/copilot-sdk/docs/setup/scaling.md`:1-25, 27-65, 100-158; `/home/dq042000/.copilot/session-state/8834211e-10a5-4031-aeca-eee7972c730b/files/copilot-sdk/docs/setup/bundled-cli.md`:1-30, 50-79, 172-220 (commit `1dba08d1aca531f0980b0156b4950d74fd26f028`).

[^11]: `/home/dq042000/.copilot/session-state/8834211e-10a5-4031-aeca-eee7972c730b/files/copilot-sdk/docs/features/mcp.md`:1-25, 26-56, 58-99 (commit `1dba08d1aca531f0980b0156b4950d74fd26f028`).

[^12]: `/home/dq042000/.copilot/session-state/8834211e-10a5-4031-aeca-eee7972c730b/files/copilot-sdk/docs/features/custom-agents.md`:1-25, 26-58, 64-93 (commit `1dba08d1aca531f0980b0156b4950d74fd26f028`).

[^13]: `/home/dq042000/.copilot/session-state/8834211e-10a5-4031-aeca-eee7972c730b/files/copilot-sdk/docs/features/skills.md`:1-18, 19-37, 41-65, 69-111 (commit `1dba08d1aca531f0980b0156b4950d74fd26f028`).

[^14]: `/home/dq042000/.copilot/session-state/8834211e-10a5-4031-aeca-eee7972c730b/files/copilot-sdk/docs/features/session-persistence.md`:1-25, 22-44, 46-64, 95-109 (commit `1dba08d1aca531f0980b0156b4950d74fd26f028`).

[^15]: `/home/dq042000/.copilot/session-state/8834211e-10a5-4031-aeca-eee7972c730b/files/copilot-sdk/docs/features/steering-and-queueing.md`:1-13, 181-193, 540-562 (commit `1dba08d1aca531f0980b0156b4950d74fd26f028`).

[^16]: `/home/dq042000/.copilot/session-state/8834211e-10a5-4031-aeca-eee7972c730b/files/copilot-sdk/docs/hooks/index.md`:1-20, 22-48; `/home/dq042000/.copilot/session-state/8834211e-10a5-4031-aeca-eee7972c730b/files/copilot-sdk/docs/hooks/pre-tool-use.md`:1-8, 10-29, 102-129; `/home/dq042000/.copilot/session-state/8834211e-10a5-4031-aeca-eee7972c730b/files/copilot-sdk/docs/hooks/error-handling.md`:1-8, 10-29, 102-121 (commit `1dba08d1aca531f0980b0156b4950d74fd26f028`).

[^17]: `/home/dq042000/.copilot/session-state/8834211e-10a5-4031-aeca-eee7972c730b/files/copilot-sdk/nodejs/src/types.ts`:179-262, 713-830; `/home/dq042000/.copilot/session-state/8834211e-10a5-4031-aeca-eee7972c730b/files/copilot-sdk/nodejs/src/index.ts`:11-58 (commit `1dba08d1aca531f0980b0156b4950d74fd26f028`).

[^18]: `/home/dq042000/.copilot/session-state/8834211e-10a5-4031-aeca-eee7972c730b/files/copilot-sdk/nodejs/src/client.ts`:214-265, 317-365, 553-623, 1419-1655 (commit `1dba08d1aca531f0980b0156b4950d74fd26f028`).

[^19]: `/home/dq042000/.copilot/session-state/8834211e-10a5-4031-aeca-eee7972c730b/files/copilot-sdk/python/copilot/client.py`:87-117, 259-310, 427-520, 1327-1415; `/home/dq042000/.copilot/session-state/8834211e-10a5-4031-aeca-eee7972c730b/files/copilot-sdk/python/copilot/tools.py`:1-140; `/home/dq042000/.copilot/session-state/8834211e-10a5-4031-aeca-eee7972c730b/files/copilot-sdk/python/copilot/types.py`:533-646 (commit `1dba08d1aca531f0980b0156b4950d74fd26f028`).

[^20]: `/home/dq042000/.copilot/session-state/8834211e-10a5-4031-aeca-eee7972c730b/files/copilot-sdk/go/client.go`:75-190, 485-560, 1162-1230; `/home/dq042000/.copilot/session-state/8834211e-10a5-4031-aeca-eee7972c730b/files/copilot-sdk/go/definetool.go`:15-40, 42-64, 102-131; `/home/dq042000/.copilot/session-state/8834211e-10a5-4031-aeca-eee7972c730b/files/copilot-sdk/go/types.go`:360-479, 481-530; `/home/dq042000/.copilot/session-state/8834211e-10a5-4031-aeca-eee7972c730b/files/copilot-sdk/go/permissions.go`:3-10 (commit `1dba08d1aca531f0980b0156b4950d74fd26f028`).

[^21]: `/home/dq042000/.copilot/session-state/8834211e-10a5-4031-aeca-eee7972c730b/files/copilot-sdk/dotnet/src/Client.cs`:122-154, 180-220, 393-460, 1029-1089; `/home/dq042000/.copilot/session-state/8834211e-10a5-4031-aeca-eee7972c730b/files/copilot-sdk/dotnet/src/Types.cs`:1262-1363, 1457-1552; `/home/dq042000/.copilot/session-state/8834211e-10a5-4031-aeca-eee7972c730b/files/copilot-sdk/dotnet/src/PermissionHandlers.cs`:7-13 (commit `1dba08d1aca531f0980b0156b4950d74fd26f028`).

[^22]: `/home/dq042000/.copilot/session-state/8834211e-10a5-4031-aeca-eee7972c730b/files/copilot-sdk/nodejs/src/extension.ts`:1-43 (commit `1dba08d1aca531f0980b0156b4950d74fd26f028`).

[^23]: `/home/dq042000/.copilot/session-state/8834211e-10a5-4031-aeca-eee7972c730b/files/copilot-sdk/go/internal/e2e/ask_user_test.go`:1-40; `/home/dq042000/.copilot/session-state/8834211e-10a5-4031-aeca-eee7972c730b/files/copilot-sdk/go/internal/e2e/hooks_test.go`:1-40; `/home/dq042000/.copilot/session-state/8834211e-10a5-4031-aeca-eee7972c730b/files/copilot-sdk/go/internal/e2e/mcp_and_agents_test.go`:1-40; `/home/dq042000/.copilot/session-state/8834211e-10a5-4031-aeca-eee7972c730b/files/copilot-sdk/go/internal/e2e/skills_test.go`:1-40; `/home/dq042000/.copilot/session-state/8834211e-10a5-4031-aeca-eee7972c730b/files/copilot-sdk/go/internal/e2e/streaming_fidelity_test.go`:1-35; `/home/dq042000/.copilot/session-state/8834211e-10a5-4031-aeca-eee7972c730b/files/copilot-sdk/go/internal/e2e/compaction_test.go`:1-35 (commit `1dba08d1aca531f0980b0156b4950d74fd26f028`).

[^24]: `/home/dq042000/.copilot/session-state/8834211e-10a5-4031-aeca-eee7972c730b/files/copilot-sdk/CHANGELOG.md`:8-124 (commit `1dba08d1aca531f0980b0156b4950d74fd26f028`).

[^25]: `/home/dq042000/.copilot/session-state/8834211e-10a5-4031-aeca-eee7972c730b/files/copilot-sdk/python/e2e/test_ask_user.py`:1-30; `/home/dq042000/.copilot/session-state/8834211e-10a5-4031-aeca-eee7972c730b/files/copilot-sdk/python/e2e/test_hooks.py`:1-35; `/home/dq042000/.copilot/session-state/8834211e-10a5-4031-aeca-eee7972c730b/files/copilot-sdk/python/e2e/test_mcp_and_agents.py`:1-35; `/home/dq042000/.copilot/session-state/8834211e-10a5-4031-aeca-eee7972c730b/files/copilot-sdk/python/e2e/test_skills.py`:1-35; `/home/dq042000/.copilot/session-state/8834211e-10a5-4031-aeca-eee7972c730b/files/copilot-sdk/python/e2e/test_streaming_fidelity.py`:1-35; `/home/dq042000/.copilot/session-state/8834211e-10a5-4031-aeca-eee7972c730b/files/copilot-sdk/python/e2e/test_compaction.py`:1-35 (commit `1dba08d1aca531f0980b0156b4950d74fd26f028`).

[^26]: `/home/dq042000/.copilot/session-state/8834211e-10a5-4031-aeca-eee7972c730b/files/copilot-sdk/dotnet/test/AskUserTests.cs`:11-29; `/home/dq042000/.copilot/session-state/8834211e-10a5-4031-aeca-eee7972c730b/files/copilot-sdk/dotnet/test/HooksTests.cs`:11-29; `/home/dq042000/.copilot/session-state/8834211e-10a5-4031-aeca-eee7972c730b/files/copilot-sdk/dotnet/test/McpAndAgentsTests.cs`:11-30; `/home/dq042000/.copilot/session-state/8834211e-10a5-4031-aeca-eee7972c730b/files/copilot-sdk/dotnet/test/SkillsTests.cs`:10-30; `/home/dq042000/.copilot/session-state/8834211e-10a5-4031-aeca-eee7972c730b/files/copilot-sdk/dotnet/test/StreamingFidelityTests.cs`:11-25; `/home/dq042000/.copilot/session-state/8834211e-10a5-4031-aeca-eee7972c730b/files/copilot-sdk/dotnet/test/CompactionTests.cs`:12-25 (commit `1dba08d1aca531f0980b0156b4950d74fd26f028`).

[^27]: `/home/dq042000/.copilot/session-state/8834211e-10a5-4031-aeca-eee7972c730b/files/research-artifacts/copilot-sdk-recent-commits.txt`:1-5 (derived from local clone at commit `1dba08d1aca531f0980b0156b4950d74fd26f028`).

[^28]: `/home/dq042000/.copilot/session-state/8834211e-10a5-4031-aeca-eee7972c730b/files/copilot-sdk/docs/getting-started.md`:1404-1510 (commit `1dba08d1aca531f0980b0156b4950d74fd26f028`).
