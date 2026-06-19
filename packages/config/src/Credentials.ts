import { execSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import crypto from 'crypto';

export class CredentialsManager {
  private secretsPath: string;
  private isWindows: boolean;
  private fallbackKey: string;

  constructor() {
    const orbitDir = join(homedir(), '.orbit');
    if (!existsSync(orbitDir)) {
      mkdirSync(orbitDir, { recursive: true });
    }
    this.secretsPath = join(orbitDir, 'secrets.json');
    this.isWindows = process.platform === 'win32';
    // Derive a platform-independent key using homedir path
    this.fallbackKey = crypto.createHash('sha256').update(homedir()).digest('hex');
  }

  /**
   * Store a secret value securely under the given key.
   */
  public storeSecret(key: string, value: string): void {
    const secrets = this.loadSecretsFile();
    const encrypted = this.isWindows
      ? this.encryptWindows(value)
      : this.encryptFallback(value);

    secrets[key] = encrypted;
    this.saveSecretsFile(secrets);
  }

  /**
   * Retrieve a securely stored secret value.
   */
  public getSecret(key: string): string | null {
    const secrets = this.loadSecretsFile();
    const encrypted = secrets[key];
    if (!encrypted) return null;

    try {
      return this.isWindows
        ? this.decryptWindows(encrypted)
        : this.decryptFallback(encrypted);
    } catch {
      return null;
    }
  }

  private loadSecretsFile(): Record<string, string> {
    if (!existsSync(this.secretsPath)) {
      return {};
    }
    try {
      const raw = readFileSync(this.secretsPath, 'utf8');
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }

  private saveSecretsFile(secrets: Record<string, string>): void {
    writeFileSync(this.secretsPath, JSON.stringify(secrets, null, 2), 'utf8');
  }

  // Windows DPAPI Encryption using PowerShell over stdin
  private encryptWindows(plainText: string): string {
    try {
      const cmd = 'powershell.exe -NoProfile -NonInteractive -Command "$plain = [Console]::In.ReadLine(); if ($plain) { $plain | ConvertTo-SecureString -AsPlainText -Force | ConvertFrom-SecureString }"';
      const stdout = execSync(cmd, {
        input: plainText + '\n',
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'ignore'],
      });
      return stdout.trim();
    } catch (err: any) {
      throw new Error(`Windows encryption failed: ${err.message}`);
    }
  }

  // Windows DPAPI Decryption using PowerShell over stdin
  private decryptWindows(cipherText: string): string {
    try {
      const cmd = 'powershell.exe -NoProfile -NonInteractive -Command "$cipher = [Console]::In.ReadLine(); if ($cipher) { $secure = ConvertTo-SecureString $cipher; [System.Runtime.InteropServices.Marshal]::PtrToStringAuto([System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)) }"';
      const stdout = execSync(cmd, {
        input: cipherText + '\n',
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'ignore'],
      });
      return stdout.trim();
    } catch (err: any) {
      throw new Error(`Windows decryption failed: ${err.message}`);
    }
  }

  // Fallback platform-independent AES encryption
  private encryptFallback(plainText: string): string {
    const iv = crypto.randomBytes(12);
    const key = Buffer.from(this.fallbackKey, 'hex').slice(0, 32);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    
    let encrypted = cipher.update(plainText, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const authTag = cipher.getAuthTag().toString('hex');

    return JSON.stringify({
      iv: iv.toString('hex'),
      encrypted,
      tag: authTag,
    });
  }

  // Fallback platform-independent AES decryption
  private decryptFallback(cipherText: string): string {
    const { iv, encrypted, tag } = JSON.parse(cipherText);
    const key = Buffer.from(this.fallbackKey, 'hex').slice(0, 32);
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      key,
      Buffer.from(iv, 'hex')
    );
    
    decipher.setAuthTag(Buffer.from(tag, 'hex'));
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  }
}
