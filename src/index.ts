import type { Plugin, PluginInput } from "@opencode-ai/plugin";
import * as Sentry from "@sentry/node";
import { basename } from "node:path";
import {
  loadPluginConfig,
  type PluginLogger,
  type ResolvedPluginConfig,
} from "./config";
import { serializeAttribute } from "./serialize";

type SentrySpan = ReturnType<typeof Sentry.startInactiveSpan>;

interface SessionState {
  sessionID: string;
  providerID: string;
  modelID: string;
  sessionSpan?: SentrySpan;
  completedAssistantMessages: Set<string>;
}

const sessions = new Map<string, SessionState>();
const toolSpans = new Map<string, SentrySpan>();
const sessionToolSpanKeys = new Map<string, Set<string>>();
const messageTextParts = new Map<string, Map<string, string>>();
const sessionMessages = new Map<string, Set<string>>();
const sessionFlushes = new Map<string, Promise<void>>();
const lastSessionFlushAt = new Map<string, number>();

const MAX_SESSION_MESSAGES = 2048;
const MAX_CACHED_MESSAGE_PARTS = 128;
const MAX_COMPLETED_ASSISTANT_MESSAGES = 2048;
const IDLE_FLUSH_COOLDOWN_MS = 1200;

let sentryInitialized = false;
let initializedDsn: string | null = null;

function createLogger(_input: PluginInput): PluginLogger {
  const service = "opencode-sentry-monitor";

  const appLogger =
    _input.client &&
    typeof _input.client === "object" &&
    "app" in _input.client &&
    _input.client.app &&
    typeof _input.client.app.log === "function"
      ? _input.client.app.log.bind(_input.client.app)
      : undefined;

  const write = (
    level: "debug" | "info" | "warn" | "error",
    message: string,
    extra?: Record<string, unknown>,
  ): void => {
    const prefix = `[${service}] ${message}`;

    if (appLogger) {
      void appLogger({
        body: {
          service,
          level,
          message,
          extra,
        },
      }).catch(() => {
        // Ignore app logger failures and continue with console logs.
      });
    }

    if (level === "error") {
      // eslint-disable-next-line no-console
      console.error(prefix, extra ?? "");
      return;
    }
    if (level === "warn") {
      // eslint-disable-next-line no-console
      console.warn(prefix, extra ?? "");
      return;
    }
    if (level === "debug") {
      // eslint-disable-next-line no-console
      console.debug(prefix, extra ?? "");
      return;
    }
    // eslint-disable-next-line no-console
    console.info(prefix, extra ?? "");
  };

  return {
    debug: (message, extra) => write("debug", message, extra),
    info: (message, extra) => write("info", message, extra),
    warn: (message, extra) => write("warn", message, extra),
    error: (message, extra) => write("error", message, extra),
  };
}

function logDiagnostics(
  logger: PluginLogger,
  config: ResolvedPluginConfig,
  message: string,
  extra?: Record<string, unknown>,
): void {
  if (!config.diagnostics) {
    return;
  }

  logger.debug(message, extra);
}

function logDiagnosticsLazy(
  logger: PluginLogger,
  config: ResolvedPluginConfig,
  message: string,
  createExtra: () => Record<string, unknown>,
): void {
  if (!config.diagnostics) {
    return;
  }

  logger.debug(message, createExtra());
}

function closeSessionToolSpans(sessionID: string): number {
  const keys = sessionToolSpanKeys.get(sessionID);
  if (!keys || keys.size === 0) {
    return 0;
  }

  let closed = 0;

  for (const key of keys) {
    const span = toolSpans.get(key);
    if (!span) {
      continue;
    }

    setSpanStatus(span, true);
    span.end();
    toolSpans.delete(key);
    closed += 1;
  }

  sessionToolSpanKeys.delete(sessionID);

  return closed;
}

function rememberSessionMessage(sessionID: string, messageID: string): void {
  let messageIDs = sessionMessages.get(sessionID);
  if (!messageIDs) {
    messageIDs = new Set<string>();
    sessionMessages.set(sessionID, messageIDs);
  }

  if (!messageIDs.has(messageID) && messageIDs.size >= MAX_SESSION_MESSAGES) {
    const oldestMessageID = messageIDs.values().next().value;
    if (typeof oldestMessageID === "string") {
      messageIDs.delete(oldestMessageID);
      messageTextParts.delete(oldestMessageID);
    }
  }

  messageIDs.add(messageID);
}

function truncateText(value: string, maxLength: number): string {
  if (maxLength <= 0) {
    return "";
  }

  if (value.length <= maxLength) {
    return value;
  }

  const omitted = value.length - maxLength;
  return `${value.slice(0, maxLength)}...[truncated ${omitted} chars]`;
}

function trimCachedMessageText(text: string, maxLength: number): string {
  return truncateText(text.trim(), maxLength);
}

function upsertMessageTextPart(
  sessionID: string,
  messageID: string,
  partID: string,
  text: string,
  maxLength: number,
): void {
  rememberSessionMessage(sessionID, messageID);

  let parts = messageTextParts.get(messageID);
  if (!parts) {
    parts = new Map<string, string>();
    messageTextParts.set(messageID, parts);
  }

  const normalized = trimCachedMessageText(text, maxLength);
  if (normalized.length === 0) {
    parts.delete(partID);
  } else {
    if (!parts.has(partID) && parts.size >= MAX_CACHED_MESSAGE_PARTS) {
      const oldestPartID = parts.keys().next().value;
      if (typeof oldestPartID === "string") {
        parts.delete(oldestPartID);
      }
    }

    parts.set(partID, normalized);
  }

  if (parts.size === 0) {
    messageTextParts.delete(messageID);
  }
}

function removeMessageTextPart(messageID: string, partID: string): void {
  const parts = messageTextParts.get(messageID);
  if (!parts) {
    return;
  }

  parts.delete(partID);
  if (parts.size === 0) {
    messageTextParts.delete(messageID);
  }
}

function removeMessageText(messageID: string, sessionID?: string): void {
  messageTextParts.delete(messageID);

  if (!sessionID) {
    return;
  }

  const messageIDs = sessionMessages.get(sessionID);
  if (!messageIDs) {
    return;
  }

  messageIDs.delete(messageID);
  if (messageIDs.size === 0) {
    sessionMessages.delete(sessionID);
  }
}

function getMessageText(
  messageID: string,
  maxLength: number,
): string | undefined {
  const parts = messageTextParts.get(messageID);
  if (!parts || parts.size === 0) {
    return undefined;
  }

  const softLimit = Math.max(maxLength + 128, maxLength);
  const assembledParts: string[] = [];
  let assembledLength = 0;

  for (const part of parts.values()) {
    const normalized = part;
    if (normalized.length === 0) {
      continue;
    }

    const separatorLength = assembledParts.length > 0 ? 2 : 0;
    assembledParts.push(normalized);
    assembledLength += separatorLength + normalized.length;
    if (assembledLength >= softLimit) {
      break;
    }
  }

  const assembled = truncateText(assembledParts.join("\n\n"), maxLength);

  return assembled.length > 0 ? assembled : undefined;
}

function cleanupSessionMessageState(sessionID: string): void {
  const messageIDs = sessionMessages.get(sessionID);
  if (!messageIDs) {
    return;
  }

  for (const messageID of messageIDs) {
    messageTextParts.delete(messageID);
  }

  sessionMessages.delete(sessionID);
}

async function flushSentry(
  config: ResolvedPluginConfig,
  logger: PluginLogger,
  reason: string,
  sessionID: string,
  options?: {
    force?: boolean;
  },
): Promise<void> {
  const now = Date.now();
  const force = options?.force ?? false;

  if (!force && reason === "session.idle") {
    const lastFlushedAt = lastSessionFlushAt.get(sessionID);
    if (
      typeof lastFlushedAt === "number" &&
      now - lastFlushedAt < IDLE_FLUSH_COOLDOWN_MS
    ) {
      logDiagnostics(logger, config, "Skipping flush during idle cooldown", {
        reason,
        sessionID,
        cooldownMs: IDLE_FLUSH_COOLDOWN_MS,
      });
      return;
    }
  }

  const inFlight = sessionFlushes.get(sessionID);
  if (inFlight) {
    await inFlight;
    return;
  }

  const flushPromise = (async (): Promise<void> => {
    const started = Date.now();
    try {
      const flushed = await Sentry.flush(config.flushTimeoutMs);
      if (reason === "session.idle") {
        lastSessionFlushAt.set(sessionID, Date.now());
      }
      logDiagnostics(logger, config, "Sentry flush completed", {
        reason,
        sessionID,
        flushed,
        flushTimeoutMs: config.flushTimeoutMs,
        durationMs: Date.now() - started,
      });
    } catch (error) {
      logger.warn("Sentry flush failed", {
        reason,
        sessionID,
        flushTimeoutMs: config.flushTimeoutMs,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  })();

  sessionFlushes.set(sessionID, flushPromise);
  try {
    await flushPromise;
  } finally {
    sessionFlushes.delete(sessionID);
  }
}

function getEventSessionID(event: {
  type: string;
  properties: unknown;
}): string | undefined {
  const properties =
    event.properties && typeof event.properties === "object"
      ? (event.properties as Record<string, unknown>)
      : undefined;

  if (!properties) {
    return undefined;
  }

  if (typeof properties.sessionID === "string") {
    return properties.sessionID;
  }

  const info =
    properties.info && typeof properties.info === "object"
      ? (properties.info as Record<string, unknown>)
      : undefined;

  if (info && typeof info.id === "string") {
    return info.id;
  }

  return undefined;
}

function getProjectName(
  config: ResolvedPluginConfig,
  input: PluginInput,
): string {
  if (config.projectName && config.projectName.length > 0) {
    return config.projectName;
  }

  if (input.project?.worktree && input.project.worktree.length > 0) {
    const fromWorktree = basename(input.project.worktree);
    if (fromWorktree.length > 0) {
      return fromWorktree;
    }
  }

  const guessed = basename(input.directory);
  return guessed.length > 0 ? guessed : "opencode-project";
}

function getAgentName(
  config: ResolvedPluginConfig,
  projectName: string,
): string {
  if (config.agentName && config.agentName.length > 0) {
    return config.agentName;
  }

  return projectName;
}

function getSessionState(sessionID: string): SessionState {
  const existing = sessions.get(sessionID);
  if (existing) {
    return existing;
  }

  const created: SessionState = {
    sessionID,
    providerID: "unknown",
    modelID: "unknown-model",
    completedAssistantMessages: new Set<string>(),
  };

  sessions.set(sessionID, created);
  return created;
}

function setSessionModel(
  sessionID: string,
  providerID: string,
  modelID: string,
): void {
  const state = getSessionState(sessionID);
  state.providerID = providerID;
  state.modelID = modelID;

  if (state.sessionSpan) {
    state.sessionSpan.setAttribute("gen_ai.request.model", modelID);
    state.sessionSpan.setAttribute("opencode.model.provider", providerID);
  }
}

function getToolSpanKey(sessionID: string, callID: string): string {
  return `${sessionID}:${callID}`;
}

function trackToolSpanKey(sessionID: string, key: string): void {
  let keys = sessionToolSpanKeys.get(sessionID);
  if (!keys) {
    keys = new Set<string>();
    sessionToolSpanKeys.set(sessionID, keys);
  }

  keys.add(key);
}

function untrackToolSpanKey(sessionID: string, key: string): void {
  const keys = sessionToolSpanKeys.get(sessionID);
  if (!keys) {
    return;
  }

  keys.delete(key);
  if (keys.size === 0) {
    sessionToolSpanKeys.delete(sessionID);
  }
}

function setSpanStatus(span: SentrySpan, isError: boolean): void {
  span.setStatus({ code: isError ? 2 : 1 });
}

function ensureSessionSpan(
  sessionID: string,
  config: ResolvedPluginConfig,
  projectName: string,
  agentName: string,
): SentrySpan {
  const state = getSessionState(sessionID);

  if (state.sessionSpan) {
    return state.sessionSpan;
  }

  const sessionSpan = Sentry.startInactiveSpan({
    op: "gen_ai.invoke_agent",
    name: `invoke_agent ${agentName}`,
    forceTransaction: true,
    attributes: {
      "gen_ai.operation.name": "invoke_agent",
      "gen_ai.agent.name": agentName,
      "gen_ai.request.model": state.modelID,
      "gen_ai.conversation.id": sessionID,
      "opencode.model.provider": state.providerID,
      "opencode.session.id": sessionID,
      "opencode.project.name": projectName,
      "opencode.capture.session_events": config.includeSessionEvents,
      ...config.tags,
    },
  });

  state.sessionSpan = sessionSpan;
  return sessionSpan;
}

function cleanupSession(sessionID: string): void {
  closeSessionToolSpans(sessionID);

  const state = sessions.get(sessionID);
  if (!state) {
    cleanupSessionMessageState(sessionID);
    lastSessionFlushAt.delete(sessionID);
    return;
  }

  state.sessionSpan?.end();
  sessions.delete(sessionID);
  cleanupSessionMessageState(sessionID);
  lastSessionFlushAt.delete(sessionID);
}

function toolOutputIndicatesError(output: {
  title: string;
  output: string;
  metadata: unknown;
}): boolean {
  const metadata =
    output.metadata && typeof output.metadata === "object"
      ? (output.metadata as Record<string, unknown>)
      : undefined;

  if (!metadata) {
    return /error/i.test(output.title);
  }

  if (metadata.error) {
    return true;
  }

  if (
    typeof metadata.status === "string" &&
    metadata.status.toLowerCase() === "error"
  ) {
    return true;
  }

  return /error/i.test(output.title);
}

function isMessageInfo(value: unknown): value is {
  id: string;
  role: "assistant" | "user";
  sessionID: string;
} {
  if (!value || typeof value !== "object") {
    return false;
  }

  const info = value as Record<string, unknown>;
  return (
    typeof info.id === "string" &&
    typeof info.sessionID === "string" &&
    (info.role === "assistant" || info.role === "user")
  );
}

function isTextPart(value: unknown): value is {
  id: string;
  type: "text";
  sessionID: string;
  messageID: string;
  text: string;
  synthetic?: boolean;
  ignored?: boolean;
} {
  if (!value || typeof value !== "object") {
    return false;
  }

  const part = value as Record<string, unknown>;
  return (
    part.type === "text" &&
    typeof part.id === "string" &&
    typeof part.sessionID === "string" &&
    typeof part.messageID === "string" &&
    typeof part.text === "string"
  );
}

function isAssistantMessageInfo(value: unknown): value is {
  id: string;
  role: "assistant";
  sessionID: string;
  parentID?: string;
  modelID: string;
  providerID: string;
  tokens: {
    input: number;
    output: number;
    reasoning: number;
    cache: {
      read: number;
      write: number;
    };
  };
  time: {
    created: number;
    completed?: number;
  };
} {
  if (!value || typeof value !== "object") {
    return false;
  }

  const info = value as Record<string, unknown>;
  const time = info.time as Record<string, unknown> | undefined;

  return (
    typeof info.id === "string" &&
    info.role === "assistant" &&
    typeof info.sessionID === "string" &&
    (typeof info.parentID === "string" || info.parentID === undefined) &&
    typeof info.modelID === "string" &&
    typeof info.providerID === "string" &&
    typeof time?.created === "number"
  );
}

function attachTokenUsage(
  span: SentrySpan,
  tokens: {
    input: number;
    output: number;
    reasoning: number;
    cache: {
      read: number;
      write: number;
    };
  },
): void {
  if (typeof tokens.input === "number") {
    span.setAttribute("gen_ai.usage.input_tokens", tokens.input);
  }
  if (typeof tokens.output === "number") {
    span.setAttribute("gen_ai.usage.output_tokens", tokens.output);
  }
  if (typeof tokens.reasoning === "number") {
    span.setAttribute("gen_ai.usage.output_tokens.reasoning", tokens.reasoning);
  }
  if (typeof tokens.cache?.read === "number") {
    span.setAttribute("gen_ai.usage.input_tokens.cached", tokens.cache.read);
  }
  if (typeof tokens.cache?.write === "number") {
    span.setAttribute(
      "gen_ai.usage.input_tokens.cache_write",
      tokens.cache.write,
    );
  }
  if (typeof tokens.input === "number" && typeof tokens.output === "number") {
    span.setAttribute(
      "gen_ai.usage.total_tokens",
      tokens.input + tokens.output,
    );
  }
}

function initSentry(config: ResolvedPluginConfig, logger: PluginLogger): void {
  if (!sentryInitialized) {
    Sentry.init({
      dsn: config.dsn,
      tracesSampleRate: config.tracesSampleRate,
      environment: config.environment,
      release: config.release,
      debug: config.debug,
      sendDefaultPii: false,
    });

    sentryInitialized = true;
    initializedDsn = config.dsn;
    return;
  }

  if (initializedDsn && initializedDsn !== config.dsn) {
    logger.warn(
      "Sentry is already initialized with a different DSN. Keeping the original client.",
      {
        initializedDsn,
        requestedDsn: config.dsn,
      },
    );
  }
}

function captureSessionError(
  sessionID: string | undefined,
  payload: unknown,
  maxAttributeLength: number,
  customTags: Record<string, string>,
): void {
  Sentry.captureMessage("OpenCode session.error", {
    level: "error",
    tags: {
      "opencode.session.id": sessionID ?? "unknown",
      ...customTags,
    },
    extra: {
      payload: serializeAttribute(payload, maxAttributeLength),
    },
  });
}

function rememberCompletedAssistantMessage(
  state: SessionState,
  messageID: string,
): boolean {
  if (state.completedAssistantMessages.has(messageID)) {
    return false;
  }

  if (state.completedAssistantMessages.size >= MAX_COMPLETED_ASSISTANT_MESSAGES) {
    const oldestMessageID = state.completedAssistantMessages.values().next().value;
    if (typeof oldestMessageID === "string") {
      state.completedAssistantMessages.delete(oldestMessageID);
    }
  }

  state.completedAssistantMessages.add(messageID);
  return true;
}

export const SentryObservabilityPlugin: Plugin = async (input) => {
  const logger = createLogger(input);
  const loaded = await loadPluginConfig(input, logger);

  if (!loaded) {
    return {};
  }

  const config = loaded.config;
  const projectName = getProjectName(config, input);
  const agentName = getAgentName(config, projectName);
  const shouldCacheMessageText =
    config.includeMessageUsageSpans && (config.recordInputs || config.recordOutputs);

  initSentry(config, logger);

  logger.info("Sentry observability plugin enabled", {
    source: loaded.source,
    projectName,
    agentName,
    tracesSampleRate: config.tracesSampleRate,
    recordInputs: config.recordInputs,
    recordOutputs: config.recordOutputs,
    diagnostics: config.diagnostics,
    flushTimeoutMs: config.flushTimeoutMs,
  });

  return {
    "chat.params": async (hookInput) => {
      try {
        setSessionModel(
          hookInput.sessionID,
          hookInput.model.providerID,
          hookInput.model.id,
        );

        const sessionSpan = ensureSessionSpan(
          hookInput.sessionID,
          config,
          projectName,
          agentName,
        );

        sessionSpan.setAttribute("gen_ai.request.model", hookInput.model.id);
        sessionSpan.setAttribute(
          "opencode.model.provider",
          hookInput.model.providerID,
        );

        logDiagnostics(logger, config, "chat.params received", {
          sessionID: hookInput.sessionID,
          agent: hookInput.agent,
          modelID: hookInput.model.id,
          providerID: hookInput.model.providerID,
        });
      } catch (error) {
        logger.warn("Failed to capture chat.params model metadata", {
          error: error instanceof Error ? error.message : String(error),
          sessionID: hookInput.sessionID,
        });
      }
    },

    "tool.execute.before": async (hookInput, hookOutput) => {
      let span: SentrySpan | undefined;
      let key: string | undefined;

      try {
        logDiagnosticsLazy(logger, config, "tool.execute.before", () => ({
          sessionID: hookInput.sessionID,
          callID: hookInput.callID,
          tool: hookInput.tool,
        }));

        const parentSessionSpan = ensureSessionSpan(
          hookInput.sessionID,
          config,
          projectName,
          agentName,
        );

        const state = getSessionState(hookInput.sessionID);
        span = Sentry.startInactiveSpan({
          parentSpan: parentSessionSpan,
          op: "gen_ai.execute_tool",
          name: `execute_tool ${hookInput.tool}`,
          attributes: {
            "gen_ai.operation.name": "execute_tool",
            "gen_ai.agent.name": agentName,
            "gen_ai.request.model": state.modelID,
            "opencode.model.provider": state.providerID,
            "gen_ai.tool.name": hookInput.tool,
            "gen_ai.conversation.id": hookInput.sessionID,
            "opencode.session.id": hookInput.sessionID,
            "opencode.call.id": hookInput.callID,
            "opencode.project.name": projectName,
            ...config.tags,
          },
        });

        if (config.recordInputs) {
          span.setAttribute(
            "gen_ai.tool.input",
            serializeAttribute(hookOutput.args, config.maxAttributeLength),
          );
        }

        key = getToolSpanKey(hookInput.sessionID, hookInput.callID);
        toolSpans.set(key, span);
        trackToolSpanKey(hookInput.sessionID, key);
      } catch (error) {
        if (key) {
          toolSpans.delete(key);
          untrackToolSpanKey(hookInput.sessionID, key);
        }

        if (span) {
          setSpanStatus(span, true);
          span.end();
        }

        logger.warn("Failed to start tool span", {
          error: error instanceof Error ? error.message : String(error),
          sessionID: hookInput.sessionID,
          callID: hookInput.callID,
          tool: hookInput.tool,
        });
      }
    },

    "tool.execute.after": async (hookInput, hookOutput) => {
      const key = getToolSpanKey(hookInput.sessionID, hookInput.callID);

      try {
        logDiagnosticsLazy(logger, config, "tool.execute.after", () => ({
          sessionID: hookInput.sessionID,
          callID: hookInput.callID,
          tool: hookInput.tool,
        }));

        const span = toolSpans.get(key);
        if (!span) {
          untrackToolSpanKey(hookInput.sessionID, key);
          logDiagnosticsLazy(logger, config, "Missing tool span for tool.execute.after", () => ({
            sessionID: hookInput.sessionID,
            callID: hookInput.callID,
            tool: hookInput.tool,
          }));
          return;
        }

        const isError = toolOutputIndicatesError(hookOutput);
        const shouldSerializeToolOutput = config.recordOutputs || isError;
        const serializedToolOutput = shouldSerializeToolOutput
          ? serializeAttribute(hookOutput, config.maxAttributeLength)
          : undefined;

        if (config.recordOutputs && serializedToolOutput !== undefined) {
          span.setAttribute(
            "gen_ai.tool.output",
            serializedToolOutput,
          );
        }

        setSpanStatus(span, isError);

        if (isError) {
          Sentry.captureMessage(`Tool execution error: ${hookInput.tool}`, {
            level: "error",
            tags: {
              "opencode.session.id": hookInput.sessionID,
              "opencode.call.id": hookInput.callID,
              "opencode.tool": hookInput.tool,
              ...config.tags,
            },
            extra: {
              output: serializedToolOutput,
            },
          });
        }

        span.end();
        toolSpans.delete(key);
        untrackToolSpanKey(hookInput.sessionID, key);

        if (config.enableMetrics) {
          Sentry.metrics.count("gen_ai.client.tool.execution", 1, {
            attributes: {
              "gen_ai.agent.name": agentName,
              "gen_ai.tool.name": hookInput.tool,
              "opencode.project.name": projectName,
              status: isError ? "error" : "ok",
              ...config.tags,
            },
          });
        }
      } catch (error) {
        const danglingSpan = toolSpans.get(key);
        if (danglingSpan) {
          setSpanStatus(danglingSpan, true);
          danglingSpan.end();
          toolSpans.delete(key);
        }
        untrackToolSpanKey(hookInput.sessionID, key);

        logger.warn("Failed to finish tool span", {
          error: error instanceof Error ? error.message : String(error),
          sessionID: hookInput.sessionID,
          callID: hookInput.callID,
          tool: hookInput.tool,
        });
      }
    },

    event: async ({ event }) => {
      try {
        logDiagnosticsLazy(logger, config, "event received", () => ({
          eventType: event.type,
          sessionID: getEventSessionID(event),
        }));

        switch (event.type) {
          case "session.created": {
            const sessionID = event.properties.info.id;
            ensureSessionSpan(sessionID, config, projectName, agentName);
            break;
          }

          case "session.deleted": {
            const sessionID = event.properties.info.id;
            const pendingToolSpans = closeSessionToolSpans(sessionID);
            logDiagnosticsLazy(logger, config, "session.deleted", () => ({
              sessionID,
              pendingToolSpans,
            }));
            cleanupSession(sessionID);
            await flushSentry(config, logger, "session.deleted", sessionID, {
              force: true,
            });
            break;
          }

          case "session.idle": {
            const sessionID = event.properties.sessionID;

            if (config.includeSessionEvents) {
              Sentry.addBreadcrumb({
                category: "opencode.session",
                level: "info",
                message: "session.idle",
                data: {
                  sessionID,
                },
              });
            }

            const state = sessions.get(sessionID);
            const pendingToolSpans = closeSessionToolSpans(sessionID);

            if (!state?.sessionSpan) {
              logDiagnostics(
                logger,
                config,
                "session.idle with no active session span",
                {
                  sessionID,
                  pendingToolSpans,
                  completedAssistantMessages:
                    state?.completedAssistantMessages.size ?? 0,
                },
              );
            }

            if (state?.sessionSpan) {
              state.sessionSpan.end();
              state.sessionSpan = undefined;
            }

            await flushSentry(config, logger, "session.idle", sessionID);
            break;
          }

          case "session.error": {
            captureSessionError(
              event.properties.sessionID,
              event.properties.error,
              config.maxAttributeLength,
              config.tags,
            );
            await flushSentry(
              config,
              logger,
              "session.error",
              event.properties.sessionID ?? "unknown",
              {
                force: true,
              },
            );

            break;
          }

          case "message.updated": {
            if (
              shouldCacheMessageText &&
              isMessageInfo(event.properties.info)
            ) {
              rememberSessionMessage(
                event.properties.info.sessionID,
                event.properties.info.id,
              );
            }

            if (!config.includeMessageUsageSpans) {
              break;
            }

            const info = event.properties.info;
            if (!isAssistantMessageInfo(info)) {
              break;
            }

            if (typeof info.time.completed !== "number") {
              break;
            }

            const state = getSessionState(info.sessionID);
            if (!rememberCompletedAssistantMessage(state, info.id)) {
              break;
            }

            setSessionModel(info.sessionID, info.providerID, info.modelID);

            const parentSessionSpan = ensureSessionSpan(
              info.sessionID,
              config,
              projectName,
              agentName,
            );

            const usageSpan = Sentry.startInactiveSpan({
              parentSpan: parentSessionSpan,
              op: "gen_ai.request",
              name: `request ${info.modelID}`,
              attributes: {
                "gen_ai.operation.name": "request",
                "gen_ai.request.model": info.modelID,
                "gen_ai.agent.name": agentName,
                "gen_ai.conversation.id": info.sessionID,
                "opencode.model.provider": info.providerID,
                "opencode.session.id": info.sessionID,
                "opencode.message.id": info.id,
                "opencode.project.name": projectName,
                ...config.tags,
              },
            });

            if (config.recordInputs && typeof info.parentID === "string") {
              const inputText = getMessageText(
                info.parentID,
                config.maxAttributeLength,
              );
              if (inputText) {
                usageSpan.setAttribute(
                  "gen_ai.request.messages",
                  serializeAttribute(
                    [
                      {
                        role: "user",
                        content: inputText,
                      },
                    ],
                    config.maxAttributeLength,
                  ),
                );
              } else {
                logDiagnostics(
                  logger,
                  config,
                  "No cached user text found for request input",
                  {
                    sessionID: info.sessionID,
                    messageID: info.id,
                    parentID: info.parentID,
                  },
                );
              }
            }

            if (config.recordOutputs) {
              const outputText = getMessageText(
                info.id,
                config.maxAttributeLength,
              );
              if (outputText) {
                usageSpan.setAttribute(
                  "gen_ai.response.text",
                  serializeAttribute([outputText], config.maxAttributeLength),
                );
              } else {
                logDiagnostics(
                  logger,
                  config,
                  "No cached assistant text found for response output",
                  {
                    sessionID: info.sessionID,
                    messageID: info.id,
                  },
                );
              }
            }

            attachTokenUsage(usageSpan, info.tokens);
            usageSpan.end();

            if (config.enableMetrics) {
              const metricAttrs = {
                "gen_ai.agent.name": agentName,
                "opencode.project.name": projectName,
                "gen_ai.request.model": info.modelID,
                "opencode.model.provider": info.providerID,
                ...config.tags,
              };

              if (info.tokens.input > 0) {
                Sentry.metrics.distribution(
                  "gen_ai.client.token.usage",
                  info.tokens.input,
                  {
                    attributes: {
                      ...metricAttrs,
                      "gen_ai.token.type": "input",
                    },
                    unit: "token",
                  },
                );
              }
              if (info.tokens.output > 0) {
                Sentry.metrics.distribution(
                  "gen_ai.client.token.usage",
                  info.tokens.output,
                  {
                    attributes: {
                      ...metricAttrs,
                      "gen_ai.token.type": "output",
                    },
                    unit: "token",
                  },
                );
              }
              if (info.tokens.reasoning > 0) {
                Sentry.metrics.distribution(
                  "gen_ai.client.token.usage",
                  info.tokens.reasoning,
                  {
                    attributes: {
                      ...metricAttrs,
                      "gen_ai.token.type": "reasoning",
                    },
                    unit: "token",
                  },
                );
              }
              if (info.tokens.cache?.read > 0) {
                Sentry.metrics.distribution(
                  "gen_ai.client.token.usage",
                  info.tokens.cache.read,
                  {
                    attributes: {
                      ...metricAttrs,
                      "gen_ai.token.type": "cached_input",
                    },
                    unit: "token",
                  },
                );
              }

              const durationMs = info.time.completed! - info.time.created;
              if (durationMs > 0) {
                Sentry.metrics.distribution(
                  "gen_ai.client.response.duration",
                  durationMs,
                  {
                    attributes: metricAttrs,
                    unit: "millisecond",
                  },
                );
              }
            }

            break;
          }

          case "message.part.updated": {
            if (!shouldCacheMessageText) {
              break;
            }

            const { part } = event.properties;
            if (!isTextPart(part)) {
              break;
            }

            if (part.synthetic || part.ignored) {
              removeMessageTextPart(part.messageID, part.id);
              break;
            }

            upsertMessageTextPart(
              part.sessionID,
              part.messageID,
              part.id,
              part.text,
              config.maxAttributeLength,
            );
            break;
          }

          case "message.part.removed": {
            if (!shouldCacheMessageText) {
              break;
            }

            removeMessageTextPart(
              event.properties.messageID,
              event.properties.partID,
            );
            break;
          }

          case "message.removed": {
            if (!shouldCacheMessageText) {
              break;
            }

            removeMessageText(
              event.properties.messageID,
              event.properties.sessionID,
            );
            break;
          }

          default:
            break;
        }
      } catch (error) {
        logger.warn("Failed to process OpenCode event", {
          error: error instanceof Error ? error.message : String(error),
          eventType: event.type,
        });
      }
    },
  };
};

export default SentryObservabilityPlugin;
