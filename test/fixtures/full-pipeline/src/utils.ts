// Pattern: TODO/FIXME without ticket reference, plus an `any` cast without justification.

export function formatBytes(n: number): string {
  // TODO: add support for binary (1024) vs decimal (1000) units
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function parseUnknown(raw: string): unknown {
  // FIXME: should validate against a schema before returning
  return JSON.parse(raw) as any;
}
