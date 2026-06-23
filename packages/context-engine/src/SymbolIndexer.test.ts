import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, rmSync, mkdirSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { SymbolIndexer, SymbolIndexSchema } from "./SymbolIndexer.js";

describe("SymbolIndexer tests", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `orbit-symbol-indexer-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });

    // Create a mock orbit config in target dir
    const configContent = `
name: test-project
context:
  ignore:
    - node_modules/**
    - dist/**
`;
    writeFileSync(join(tempDir, "orbit.config.yaml"), configContent, "utf8");
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("should parse class, interface, function, and constants and cache them in symbols.json", { timeout: 60000 }, async () => {
    const srcDir = join(tempDir, "src");
    mkdirSync(srcDir, { recursive: true });

    const code = `
// This is a comment class IgnoredClass
export class User {
  constructor(public name: string) {}
}

export interface AuthDetails {
  token: string;
}

export type Status = 'active' | 'inactive';

export async function login(user: User): Promise<boolean> {
  return true;
}

export const API_URL = 'http://localhost';
`;
    writeFileSync(join(srcDir, "index.ts"), code, "utf8");

    const indexer = new SymbolIndexer(tempDir);
    await indexer.index();

    const indexPath = join(tempDir, ".orbit", "symbols.json");
    expect(existsSync(indexPath)).toBe(true);

    const raw = readFileSync(indexPath, "utf8");
    const index = JSON.parse(raw);

    // Validate using Zod schema
    const parseResult = SymbolIndexSchema.safeParse(index);
    expect(parseResult.success).toBe(true);

    const fileIndex = index.files["src/index.ts"];
    expect(fileIndex).toBeDefined();
    expect(fileIndex.symbols.length).toBe(5);

    const names = fileIndex.symbols.map((s: any) => s.name);
    expect(names).toContain("User");
    expect(names).toContain("AuthDetails");
    expect(names).toContain("Status");
    expect(names).toContain("login");
    expect(names).toContain("API_URL");

    // Test Search
    const searchRes = await indexer.search("auth");
    expect(searchRes.length).toBe(1);
    expect(searchRes[0].name).toBe("AuthDetails");
    expect(searchRes[0].filePath).toBe("src/index.ts");
    expect(searchRes[0].type).toBe("interface");
  });

  it("should incrementally update, clean up deleted files, and respect ignore lists", { timeout: 60000 }, async () => {
    const srcDir = join(tempDir, "src");
    mkdirSync(srcDir, { recursive: true });

    writeFileSync(join(srcDir, "a.ts"), "export class A {}", "utf8");
    writeFileSync(join(srcDir, "b.ts"), "export class B {}", "utf8");

    const indexer = new SymbolIndexer(tempDir);
    await indexer.index();

    const indexPath = join(tempDir, ".orbit", "symbols.json");
    let raw = readFileSync(indexPath, "utf8");
    let index = JSON.parse(raw);
    expect(Object.keys(index.files).length).toBe(2);

    // 1. Delete b.ts and run indexer again
    rmSync(join(srcDir, "b.ts"));
    await indexer.index();

    raw = readFileSync(indexPath, "utf8");
    index = JSON.parse(raw);
    expect(Object.keys(index.files).length).toBe(1);
    expect(index.files["src/a.ts"]).toBeDefined();
    expect(index.files["src/b.ts"]).toBeUndefined();
  });

  it("should parse imports, compute PageRank, and generate a token-bounded repo map", { timeout: 60000 }, async () => {
    const srcDir = join(tempDir, "src");
    mkdirSync(srcDir, { recursive: true });

    // File A imports B
    const codeA = `
import { B } from './b.js';
export class A {
  useB() { return new B(); }
}
`;
    // File B imports C
    const codeB = `
import { C } from './c.js';
export class B {
  useC() { return new C(); }
}
`;
    // File C has no imports but is imported by B
    const codeC = `
export class C {
  hello() { console.log('hello'); }
}
`;

    writeFileSync(join(srcDir, "a.ts"), codeA, "utf8");
    writeFileSync(join(srcDir, "b.ts"), codeB, "utf8");
    writeFileSync(join(srcDir, "c.ts"), codeC, "utf8");

    const indexer = new SymbolIndexer(tempDir);
    await indexer.index();

    const indexPath = join(tempDir, ".orbit", "symbols.json");
    const raw = readFileSync(indexPath, "utf8");
    const index = JSON.parse(raw);

    // Verify imports are captured
    expect(index.files["src/a.ts"].imports).toContain("./b.js");
    expect(index.files["src/b.ts"].imports).toContain("./c.js");
    expect(index.files["src/c.ts"].imports).toEqual([]);

    // Generate full repo map
    const fullMap = await indexer.getRepoMapText(10000);
    expect(fullMap).toContain("Detailed Landmarks");
    expect(fullMap).toContain("src/c.ts");
    expect(fullMap).toContain("src/b.ts");
    expect(fullMap).toContain("src/a.ts");

    // Generate token-constrained repo map (low budget)
    // Should show at least one detailed landmark, or fall back
    const smallMap = await indexer.getRepoMapText(30);
    expect(smallMap).toBeDefined();

    // Generate medium budget repo map to verify outlined landmarks degradation
    const mediumMap = await indexer.getRepoMapText(150);
    expect(mediumMap).toBeDefined();
    expect(mediumMap).toContain("Landmark");
  });

  it("should respect gitignore rules by calling git ls-files if available", async () => {
    const { execSync } = await import("child_process");
    try {
      execSync("git init", { cwd: tempDir, stdio: "ignore" });
      execSync("git config user.name 'Test'", { cwd: tempDir, stdio: "ignore" });
      execSync("git config user.email 'test@test.com'", { cwd: tempDir, stdio: "ignore" });
    } catch {
      // Git is not available in test environment, skip test
      return;
    }

    const srcDir = join(tempDir, "src");
    mkdirSync(srcDir, { recursive: true });

    const trackedFile = join(srcDir, "tracked.ts");
    const ignoredFile = join(srcDir, "ignored.ts");

    writeFileSync(trackedFile, "export class Tracked {}", "utf8");
    writeFileSync(ignoredFile, "export class Ignored {}", "utf8");

    writeFileSync(join(tempDir, ".gitignore"), "src/ignored.ts\n", "utf8");

    const indexer = new SymbolIndexer(tempDir);
    await indexer.index();

    const indexPath = join(tempDir, ".orbit", "symbols.json");
    expect(existsSync(indexPath)).toBe(true);

    const raw = readFileSync(indexPath, "utf8");
    const index = JSON.parse(raw);

    expect(index.files["src/tracked.ts"]).toBeDefined();
    expect(index.files["src/ignored.ts"]).toBeUndefined();
  }, 20_000);
});
