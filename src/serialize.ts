const SENSITIVE_KEY_PATTERN =
  /(api[-_]?key|token|secret|password|authorization|cookie|session|bearer|x-api-key)/i;

function redact(value: unknown, seen: WeakSet<object>, depth: number): unknown {
  if (depth > 8) {
    return "[DepthLimit]";
  }

  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value !== "object") {
    return value;
  }

  if (seen.has(value)) {
    return "[Circular]";
  }

  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => redact(item, seen, depth + 1));
  }

  const output: Record<string, unknown> = {};

  for (const [key, nested] of Object.entries(value)) {
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      output[key] = "[REDACTED]";
      continue;
    }

    output[key] = redact(nested, seen, depth + 1);
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
  const redacted = redact(value, new WeakSet<object>(), 0);

  if (typeof redacted === "string") {
    return truncate(redacted, maxLength);
  }

  try {
    return truncate(JSON.stringify(redacted), maxLength);
  } catch {
    return "[Unserializable]";
  }
}
