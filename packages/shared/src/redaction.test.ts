import { describe, it, expect } from 'vitest';
import { redactSecrets } from './redaction.js';

describe('API keys and secrets redaction', () => {
  it('should redact OpenAI and DeepSeek API keys', () => {
    const raw = 'The key is sk-12345678901234567890123456789012';
    expect(redactSecrets(raw)).toBe('The key is sk-***REDACTED***');
  });

  it('should redact Anthropic API keys', () => {
    const raw = 'The key is sk-ant-sid01-12345678901234567890123456789012345678901234';
    expect(redactSecrets(raw)).toBe('The key is sk-ant-***REDACTED***');
  });

  it('should redact Bearer auth tokens', () => {
    const raw = 'Authorization: Bearer abcd1234efgh5678';
    expect(redactSecrets(raw)).toBe('Authorization: Bearer ***REDACTED***');
  });

  it('should redact private keys', () => {
    const raw = '-----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQDh...\n-----END PRIVATE KEY-----';
    expect(redactSecrets(raw)).toBe('***PRIVATE_KEY_REDACTED***');
  });
});
