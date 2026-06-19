const SECRET_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  {
    pattern: /\bsk-[a-zA-Z0-9]{32,}\b/g,
    replacement: 'sk-***REDACTED***',
  },
  {
    pattern: /\bsk-ant-[a-z0-9]+-[a-zA-Z0-9_\-]{40,}\b/gi,
    replacement: 'sk-ant-***REDACTED***',
  },
  {
    pattern: /Bearer\s+([a-zA-Z0-9_\-\.~+\/]+=*)/gi,
    replacement: 'Bearer ***REDACTED***',
  },
  {
    pattern: /-----BEGIN [A-Z ]+-----[\s\S]+?-----END [A-Z ]+-----/g,
    replacement: '***PRIVATE_KEY_REDACTED***',
  },
  {
    pattern: /(mongodb(?:\+srv)?:\/\/[a-zA-Z0-9_.-]+:)([^@]+)(@)/g,
    replacement: '$1***REDACTED***$3',
  },
];

export function redactSecrets(text: string): string {
  if (!text) return text;
  let redacted = text;
  for (const { pattern, replacement } of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, replacement);
  }
  return redacted;
}
