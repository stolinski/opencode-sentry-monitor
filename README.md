# opencode-sentry-monitor

Sentry AI Monitoring plugin for OpenCode.

This plugin captures OpenCode session lifecycle, tool execution spans, and assistant token usage into Sentry using AI Monitoring span conventions.

## Features

- Session-level `gen_ai.invoke_agent` spans
- Tool-level `gen_ai.execute_tool` spans (inputs/outputs optional)
- Assistant token usage spans via `message.updated` events
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
3. OpenCode active config directory (from OpenCode SDK path API)
4. `OPENCODE_CONFIG_DIR`
5. Directory of `OPENCODE_CONFIG`
6. Platform defaults:
   - `~/.config/opencode`
   - `~/Library/Application Support/opencode`
   - `~/AppData/Roaming/opencode`

If no config file exists, environment overrides are still supported:

- `OPENCODE_SENTRY_DSN` (or `SENTRY_DSN`)
- `OPENCODE_SENTRY_TRACES_SAMPLE_RATE`
- `OPENCODE_SENTRY_RECORD_INPUTS`
- `OPENCODE_SENTRY_RECORD_OUTPUTS`
- `OPENCODE_SENTRY_MAX_ATTRIBUTE_LENGTH`
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
};
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
