const SENSITIVE_KEY = /authorization|token|assertion|private|secret|password|jwt/i;

export function redactIdentifier(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  if (value.length <= 6) {
    return "***";
  }
  return `${value.slice(0, 3)}…${value.slice(-3)}`;
}

export function sanitizeLogFields(fields: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(fields).flatMap(([key, value]) => {
      if (SENSITIVE_KEY.test(key)) {
        return [];
      }
      if (typeof value === "string" && value.length > 256) {
        return [[key, "[omitted]"]];
      }
      return [[key, value]];
    })
  );
}
