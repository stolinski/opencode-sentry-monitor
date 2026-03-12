# opencode-sentry-monitor

Sentry AI Monitoring plugin for OpenCode.

This plugin captures OpenCode session lifecycle, tool execution spans, and assistant token usage into Sentry using AI Monitoring span conventions.

## Sentry Project Setup

Before using this plugin, create (or reuse) a Sentry project configured for Node SDK ingestion.

- **Project type**: `JavaScript` -> `Node.js`
- **Why this type**: OpenCode plugins run in a Node runtime, and this plugin uses `@sentry/node`
- **Required**: tracing enabled (`tracesSampleRate` > `0`) so AI Monitoring spans are stored
- **DSN source**: Project Settings -> Client Keys (DSN)

You can use an existing Node project if you already have one.

## Features

- Session-level `gen_ai.invoke_agent` spans
- Tool-level `gen_ai.execute_tool` spans (inputs/outputs optional)
- Assistant token usage spans via `message.updated` events
- Custom tags on all spans and error reports
- Unsampled metrics for token usage, response timing, and tool executions
- Sidecar config file support (no hardcoded DSN required)
- JSON and JSONC config support
- Redaction and truncation for large/sensitive payload attributes

## Install

1. Add plugin package to OpenCode config:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-sentry-monitor"]
}
```

2. Create a plugin config file with your DSN:

```json
{
  "dsn": "https://<public-key>@o<org>.ingest.sentry.io/<project-id>",
  "tracesSampleRate": 1,
  "recordInputs": true,
  "recordOutputs": true
}
```

3. Save that file as one of:

- `.opencode/sentry-monitor.json`
- `.opencode/sentry-monitor.jsonc`
- `~/.config/opencode/sentry-monitor.json`
- `~/.config/opencode/sentry-monitor.jsonc`

Restart OpenCode after installation.

## Config Resolution Order

The plugin looks for config in this order:

1. `OPENCODE_SENTRY_CONFIG` (explicit file path)
2. Project `.opencode/`
3. `OPENCODE_CONFIG_DIR`
4. Directory of `OPENCODE_CONFIG`
5. Platform defaults:
   - `~/.config/opencode`
   - `~/Library/Application Support/opencode`
   - `~/AppData/Roaming/opencode`

If no config file exists, environment overrides are still supported:

- `OPENCODE_SENTRY_DSN` (or `SENTRY_DSN`)
- `OPENCODE_SENTRY_TRACES_SAMPLE_RATE`
- `OPENCODE_SENTRY_RECORD_INPUTS`
- `OPENCODE_SENTRY_RECORD_OUTPUTS`
- `OPENCODE_SENTRY_MAX_ATTRIBUTE_LENGTH`
- `OPENCODE_SENTRY_ENABLE_METRICS`
- `OPENCODE_SENTRY_TAGS` (format: `key:value,key:value`)
- `SENTRY_ENVIRONMENT`
- `SENTRY_RELEASE`

## Config Reference

```ts
type PluginConfig = {
  dsn: string;
  tracesSampleRate?: number; // 0..1, default 1
  environment?: string;
  release?: string;
  debug?: boolean;
  agentName?: string;
  projectName?: string;
  recordInputs?: boolean; // default true
  recordOutputs?: boolean; // default true
  maxAttributeLength?: number; // default 12000
  includeMessageUsageSpans?: boolean; // default true
  includeSessionEvents?: boolean; // default true
  enableMetrics?: boolean; // default false
  tags?: Record<string, string>; // custom tags on all spans/metrics
};
```

## Metrics

When `enableMetrics: true`, the plugin emits Sentry metrics (unsampled, 100% accurate) for usage attribution:

| Metric | Type | Unit | Emitted |
|--------|------|------|---------|
| `gen_ai.client.token.usage` | distribution | token | Per assistant message, tagged by token type (input/output/reasoning/cached_input) |
| `gen_ai.client.response.duration` | distribution | millisecond | Per assistant message response time |
| `gen_ai.client.tool.execution` | counter | — | Per tool execution, tagged with status (ok/error) |

All metrics include `gen_ai.agent.name`, `opencode.project.name`, `gen_ai.request.model`, `opencode.model.provider`, plus any custom `tags`.

Example config for team attribution:

```json
{
  "dsn": "https://...",
  "enableMetrics": true,
  "agentName": "my-agent",
  "tags": {
    "team": "platform",
    "developer": "sergiy"
  }
}
```

## Local Development

```bash
npm install
npm run typecheck
npm run build
```

## Publish

```bash
npm publish
```

## Notes

- DSN is not a secret, but this plugin does not require hardcoding it.
- If `recordInputs`/`recordOutputs` are enabled, payloads are redacted and truncated before being attached as span attributes.

## License

MIT
