export function estimateTokenCount(text: string): number {
  if (!text) return 0;
  // Standard rule of thumb: ~4 characters for typical text.
  // For programming code with punctuation, estimate ~3.2 characters per token.
  return Math.ceil(text.length / 3.2);
}
