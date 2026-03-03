import type { Plugin, PluginInput } from "@opencode-ai/plugin";
import * as Sentry from "@sentry/node";
import { basename } from "node:path";
import { loadPluginConfig, type PluginLogger, type ResolvedPluginConfig } from "./config";
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

let sentryInitialized = false;
let initializedDsn: string | null = null;

function createLogger(input: PluginInput): PluginLogger {
  const service = "opencode-sentry-monitor";

  const write = (
    level: "debug" | "info" | "warn" | "error",
    message: string,
    extra?: Record<string, unknown>,
  ): void => {
    void input.client.app
      .log({
        body: {
          service,
          level,
          message,
          extra,
        },
      })
      .catch(() => {
        if (level === "error") {
          // eslint-disable-next-line no-console
          console.error(`[${service}] ${message}`, extra ?? "");
          return;
        }
        // eslint-disable-next-line no-console
        console.log(`[${service}] ${message}`);
      });
  };

  return {
    debug: (message, extra) => write("debug", message, extra),
    info: (message, extra) => write("info", message, extra),
    warn: (message, extra) => write("warn", message, extra),
    error: (message, extra) => write("error", message, extra),
  };
}

function getProjectName(config: ResolvedPluginConfig, input: PluginInput): string {
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

function getAgentName(config: ResolvedPluginConfig, projectName: string): string {
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

function setSessionModel(sessionID: string, providerID: string, modelID: string): void {
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
    },
  });

  state.sessionSpan = sessionSpan;
  return sessionSpan;
}

function cleanupSession(sessionID: string): void {
  for (const [key, span] of toolSpans) {
    if (!key.startsWith(`${sessionID}:`)) {
      continue;
    }
    span.end();
    toolSpans.delete(key);
  }

  const state = sessions.get(sessionID);
  if (!state) {
    return;
  }

  state.sessionSpan?.end();
  sessions.delete(sessionID);
}

function toolOutputIndicatesError(output: { title: string; output: string; metadata: unknown }): boolean {
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

  if (typeof metadata.status === "string" && metadata.status.toLowerCase() === "error") {
    return true;
  }

  return /error/i.test(output.title);
}

function isAssistantMessageInfo(value: unknown): value is {
  id: string;
  role: "assistant";
  sessionID: string;
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
    span.setAttribute("gen_ai.usage.input_tokens.cache_write", tokens.cache.write);
  }
  if (typeof tokens.input === "number" && typeof tokens.output === "number") {
    span.setAttribute("gen_ai.usage.total_tokens", tokens.input + tokens.output);
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
    logger.warn("Sentry is already initialized with a different DSN. Keeping the original client.", {
      initializedDsn,
      requestedDsn: config.dsn,
    });
  }
}

function captureSessionError(sessionID: string | undefined, payload: unknown): void {
  Sentry.captureMessage("OpenCode session.error", {
    level: "error",
    tags: {
      "opencode.session.id": sessionID ?? "unknown",
    },
    extra: {
      payload,
    },
  });
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

  initSentry(config, logger);

  logger.info("Sentry observability plugin enabled", {
    source: loaded.source,
    projectName,
    agentName,
    tracesSampleRate: config.tracesSampleRate,
    recordInputs: config.recordInputs,
    recordOutputs: config.recordOutputs,
  });

  return {
    "chat.params": async (hookInput) => {
      try {
        setSessionModel(hookInput.sessionID, hookInput.model.providerID, hookInput.model.id);
      } catch (error) {
        logger.warn("Failed to capture chat.params model metadata", {
          error: error instanceof Error ? error.message : String(error),
          sessionID: hookInput.sessionID,
        });
      }
    },

    "tool.execute.before": async (hookInput, hookOutput) => {
      try {
        const parentSessionSpan = ensureSessionSpan(
          hookInput.sessionID,
          config,
          projectName,
          agentName,
        );

        const state = getSessionState(hookInput.sessionID);
        const span = Sentry.startInactiveSpan({
          parentSpan: parentSessionSpan,
          op: "gen_ai.execute_tool",
          name: `execute_tool ${hookInput.tool}`,
          attributes: {
            "gen_ai.operation.name": "execute_tool",
            "gen_ai.agent.name": agentName,
            "gen_ai.request.model": state.modelID,
            "opencode.model.provider": state.providerID,
            "gen_ai.tool.name": hookInput.tool,
            "opencode.session.id": hookInput.sessionID,
            "opencode.call.id": hookInput.callID,
            "opencode.project.name": projectName,
          },
        });

        if (config.recordInputs) {
          span.setAttribute(
            "gen_ai.tool.input",
            serializeAttribute(hookOutput.args, config.maxAttributeLength),
          );
        }

        toolSpans.set(getToolSpanKey(hookInput.sessionID, hookInput.callID), span);
      } catch (error) {
        logger.warn("Failed to start tool span", {
          error: error instanceof Error ? error.message : String(error),
          sessionID: hookInput.sessionID,
          callID: hookInput.callID,
          tool: hookInput.tool,
        });
      }
    },

    "tool.execute.after": async (hookInput, hookOutput) => {
      try {
        const key = getToolSpanKey(hookInput.sessionID, hookInput.callID);
        const span = toolSpans.get(key);
        if (!span) {
          return;
        }

        if (config.recordOutputs) {
          span.setAttribute(
            "gen_ai.tool.output",
            serializeAttribute(hookOutput, config.maxAttributeLength),
          );
        }

        const isError = toolOutputIndicatesError(hookOutput);
        setSpanStatus(span, isError);

        if (isError) {
          Sentry.captureMessage(`Tool execution error: ${hookInput.tool}`, {
            level: "error",
            tags: {
              "opencode.session.id": hookInput.sessionID,
              "opencode.call.id": hookInput.callID,
              "opencode.tool": hookInput.tool,
            },
            extra: {
              output: hookOutput,
            },
          });
        }

        span.end();
        toolSpans.delete(key);
      } catch (error) {
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
        switch (event.type) {
          case "session.created": {
            const sessionID = event.properties.info.id;
            ensureSessionSpan(sessionID, config, projectName, agentName);
            break;
          }

          case "session.deleted": {
            const sessionID = event.properties.info.id;
            cleanupSession(sessionID);
            void Sentry.flush(1500);
            break;
          }

          case "session.idle": {
            if (config.includeSessionEvents) {
              Sentry.addBreadcrumb({
                category: "opencode.session",
                level: "info",
                message: "session.idle",
                data: {
                  sessionID: event.properties.sessionID,
                },
              });
            }
            void Sentry.flush(1000);
            break;
          }

          case "session.error": {
            captureSessionError(event.properties.sessionID, event.properties.error);
            break;
          }

          case "message.updated": {
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
            if (state.completedAssistantMessages.has(info.id)) {
              break;
            }
            state.completedAssistantMessages.add(info.id);

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
                "opencode.model.provider": info.providerID,
                "opencode.session.id": info.sessionID,
                "opencode.message.id": info.id,
                "opencode.project.name": projectName,
              },
            });

            attachTokenUsage(usageSpan, info.tokens);
            usageSpan.end();
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
