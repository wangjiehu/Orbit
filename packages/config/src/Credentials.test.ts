import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { CredentialsManager } from './Credentials.js';

describe('CredentialsManager tests', () => {
  let secretsPath: string;

  beforeEach(() => {
    secretsPath = join(homedir(), '.orbit', 'secrets.json');
  });

  afterEach(() => {
    if (existsSync(secretsPath)) {
      try {
        rmSync(secretsPath, { force: true });
      } catch {
        // Ignored
      }
    }
  });

  it('should store and retrieve secrets correctly', () => {
    const manager = new CredentialsManager();
    const testKey = 'TEST_RESOLVED_API_KEY';
    const testSecret = 'sk-proj-test1234567890abcdef';

    manager.storeSecret(testKey, testSecret);

    const retrieved = manager.getSecret(testKey);
    expect(retrieved).toBe(testSecret);

    // Verify it is saved in secrets.json and not in plaintext
    expect(existsSync(secretsPath)).toBe(true);
    const rawContent = readFileSync(secretsPath, 'utf8');
    expect(rawContent).not.toContain(testSecret); // must be encrypted!

    // Verify missing keys return null
    expect(manager.getSecret('NON_EXISTENT_KEY')).toBeNull();
  });
});
