const SENSITIVE_KEY_PATTERN =
  /(api[-_]?key|token|secret|password|authorization|cookie|session|bearer|x-api-key)/i;

const MAX_DEPTH = 8;
const MAX_ARRAY_ITEMS = 50;
const MAX_OBJECT_KEYS = 50;
const MAX_STRING_LENGTH = 4096;
const MIN_VISIT_BUDGET = 128;
const MAX_VISIT_BUDGET = 4096;

const TRAVERSAL_LIMIT_MARKER = "[TraversalLimit]";
const OBJECT_TRUNCATED_KEY = "__opencode_truncated__";

interface RedactionState {
  seen: WeakSet<object>;
  remainingVisits: number;
}

function resolveVisitBudget(maxLength: number): number {
  const scaled = Math.floor(maxLength / 6);
  return Math.max(MIN_VISIT_BUDGET, Math.min(MAX_VISIT_BUDGET, scaled));
}

function redact(value: unknown, state: RedactionState, depth: number): unknown {
  if (state.remainingVisits <= 0) {
    return TRAVERSAL_LIMIT_MARKER;
  }

  if (depth > MAX_DEPTH) {
    return "[DepthLimit]";
  }

  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === "string") {
    return truncate(value, MAX_STRING_LENGTH);
  }

  if (typeof value === "bigint") {
    return `${value.toString()}n`;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (typeof value === "function") {
    return "[Function]";
  }

  if (typeof value === "symbol") {
    return String(value);
  }

  if (state.seen.has(value)) {
    return "[Circular]";
  }

  state.seen.add(value);
  state.remainingVisits -= 1;

  if (Array.isArray(value)) {
    const limit = Math.min(value.length, MAX_ARRAY_ITEMS);
    const output: unknown[] = [];

    for (let i = 0; i < limit; i += 1) {
      output.push(redact(value[i], state, depth + 1));
      if (state.remainingVisits <= 0) {
        break;
      }
    }

    if (value.length > limit) {
      output.push(`[Array truncated ${value.length - limit} items]`);
    }

    return output;
  }

  const output: Record<string, unknown> = {};
  const record = value as Record<string, unknown>;
  let captured = 0;

  for (const key in record) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) {
      continue;
    }

    if (captured >= MAX_OBJECT_KEYS) {
      output[OBJECT_TRUNCATED_KEY] = "[Object key limit reached]";
      break;
    }

    if (SENSITIVE_KEY_PATTERN.test(key)) {
      output[key] = "[REDACTED]";
      captured += 1;
      continue;
    }

    output[key] = redact(record[key], state, depth + 1);
    captured += 1;

    if (state.remainingVisits <= 0) {
      output[OBJECT_TRUNCATED_KEY] = TRAVERSAL_LIMIT_MARKER;
      break;
    }
  }

  return output;
}

function truncate(value: string, maxLength: number): string {
  if (maxLength <= 0) {
    return "";
  }

  if (value.length <= maxLength) {
    return value;
  }

  const omitted = value.length - maxLength;
  return `${value.slice(0, maxLength)}...[truncated ${omitted} chars]`;
}

export function serializeAttribute(value: unknown, maxLength: number): string {
  const redacted = redact(
    value,
    {
      seen: new WeakSet<object>(),
      remainingVisits: resolveVisitBudget(maxLength),
    },
    0,
  );

  if (typeof redacted === "string") {
    return truncate(redacted, maxLength);
  }

  try {
    const serialized = JSON.stringify(redacted);
    if (typeof serialized !== "string") {
      return truncate(String(redacted), maxLength);
    }
    return truncate(serialized, maxLength);
  } catch {
    return "[Unserializable]";
  }
}
