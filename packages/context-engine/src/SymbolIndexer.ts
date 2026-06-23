import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from "fs";
import { promises as fsPromises } from "fs";
import { join, dirname, resolve } from "path";
import { createHash } from "crypto";
import glob from "fast-glob";
import { z } from "zod";
import { ConfigLoader } from "@orbit-build/config";
import { resolveSafePath, getGitBranch } from "@orbit-build/shared";
import ts from "typescript";
import { ASTChunker } from "./ASTChunker.js";
import { HybridSearch } from "./HybridSearch.js";
import {
  OpenAIProvider,
  DeepSeekOpenAIProvider,
  OllamaProvider,
} from "@orbit-build/model-providers";

export const SymbolEntrySchema = z.object({
  name: z.string(),
  type: z.enum(["class", "interface", "function", "constant", "type"]),
  line: z.number(),
});

export const FileIndexSchema = z.object({
  mtime: z.number(),
  symbols: z.array(SymbolEntrySchema),
  imports: z.array(z.string()).optional(),
});

export const SymbolIndexSchema = z.object({
  files: z.record(FileIndexSchema),
  indexedAt: z.string(),
});

export type SymbolEntry = z.infer<typeof SymbolEntrySchema>;
export type FileIndex = z.infer<typeof FileIndexSchema>;
export type SymbolIndex = z.infer<typeof SymbolIndexSchema>;

class EmbeddingCache {
  private cache: Record<string, number[]> = {};
  private cachePath: string;

  constructor(
    cwd: string,
    private modelName: string,
  ) {
    const branchName = getGitBranch(cwd);
    this.cachePath = branchName
      ? join(cwd, ".orbit", "branches", branchName, "embedding_cache.json")
      : join(cwd, ".orbit", "embedding_cache.json");
    this.load();
  }

  private load() {
    if (existsSync(this.cachePath)) {
      try {
        const raw = readFileSync(this.cachePath, "utf8");
        const parsed = JSON.parse(raw);
        if (parsed.model === this.modelName && parsed.cache) {
          this.cache = parsed.cache;
        } else {
          this.cache = {};
        }
      } catch {
        this.cache = {};
      }
    }
  }

  public save() {
    try {
      const parentDir = dirname(this.cachePath);
      if (!existsSync(parentDir)) {
        mkdirSync(parentDir, { recursive: true });
      }
      const data = {
        model: this.modelName,
        cache: this.cache,
      };
      const tmpPath = this.cachePath + ".tmp";
      writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf8");
      renameSync(tmpPath, this.cachePath);
    } catch {
      // Ignore
    }
  }

  public get(text: string): number[] | undefined {
    const hash = createHash("sha256").update(text).digest("hex");
    return this.cache[hash];
  }

  public set(text: string, vector: number[]) {
    const hash = createHash("sha256").update(text).digest("hex");
    this.cache[hash] = vector;
  }
}

export function getEmbeddingProvider(config: any) {
  const providerId = config.provider?.default || "deepseek-openai";
  const providerConfig = config.providers?.[providerId];

  if (!providerConfig) {
    return new DeepSeekOpenAIProvider(
      process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY || "no-key",
    );
  }

  const apiKey =
    providerConfig.apiKey ||
    (providerConfig.apiKeyEnv
      ? process.env[providerConfig.apiKeyEnv]
      : undefined);
  const baseUrl = providerConfig.baseUrl;

  switch (providerConfig.type) {
    case "openai":
      return new OpenAIProvider(apiKey, baseUrl);
    case "ollama":
      return new OllamaProvider(baseUrl);
    case "openai-compatible":
    case "anthropic-compatible":
    default:
      return new DeepSeekOpenAIProvider(apiKey, baseUrl);
  }
}

export class SymbolIndexer {
  public indexPath: string;

  constructor(private cwd: string) {
    const branchName = getGitBranch(cwd);
    this.indexPath = branchName
      ? join(cwd, ".orbit", "branches", branchName, "symbols.json")
      : join(cwd, ".orbit", "symbols.json");
  }

  /**
   * Run the indexer asynchronously and incrementally.
   */
  public async index(): Promise<void> {
    try {
      // Skip indexing if cwd is user's home directory or system root directory
      const normCwd = resolve(this.cwd).toLowerCase().replace(/\\/g, "/");
      const { homedir } = await import("os");
      const normHome = resolve(homedir()).toLowerCase().replace(/\\/g, "/");
      if (
        normCwd === normHome ||
        normCwd === "/" ||
        /^[a-zA-Z]:\/$/.test(normCwd) ||
        dirname(normCwd) === normCwd
      ) {
        return;
      }

      const config = ConfigLoader.loadSync(this.cwd);
      const userIgnores = config.context?.ignore || [];
      const defaultSystemIgnores = [
        "**/node_modules/**",
        "**/dist/**",
        "**/build/**",
        "**/.git/**",
        "**/coverage/**",
        "**/.next/**",
        "**/.turbo/**",
        "**/AppData/**",
        "**/Local Settings/**",
        "**/Downloads/**",
        "**/Documents/**",
        "**/Pictures/**",
        "**/Music/**",
        "**/Videos/**",
        "**/.npm/**",
        "**/.cargo/**",
        "**/.gradle/**",
        "**/.rustup/**",
        "**/.orbit/**",
      ];
      const ignorePatterns = Array.from(new Set([...userIgnores, ...defaultSystemIgnores]));

      // Load existing index if present
      let indexData: SymbolIndex = {
        files: {},
        indexedAt: new Date().toISOString(),
      };
      if (existsSync(this.indexPath)) {
        try {
          const raw = await fsPromises.readFile(this.indexPath, "utf8");
          const parsed = JSON.parse(raw);
          const validated = SymbolIndexSchema.safeParse(parsed);
          if (validated.success) {
            indexData = validated.data;
          }
        } catch {
          // Ignore parse errors and start fresh
        }
      }

      const hybridSearch = new HybridSearch(this.cwd);
      await hybridSearch.load();

      const embeddingModel =
        config.models?.embedding || "text-embedding-3-small";
      const embedCache = new EmbeddingCache(this.cwd, embeddingModel);
      let provider: any = null;
      try {
        provider = getEmbeddingProvider(config);
      } catch {
        // Fallback: provider is null, RAG will run BM25 only
      }

      // Find JS/TS files using glob matching context.ignore
      const files = await glob("**/*.{ts,tsx,js,jsx}", {
        cwd: this.cwd,
        ignore: ignorePatterns,
        onlyFiles: true,
        absolute: false,
        suppressErrors: true,
      });

      let gitFiles: Set<string> | null = null;
      try {
        const { execSync } = await import("child_process");
        const stdout = execSync("git ls-files --cached --others --exclude-standard", {
          cwd: this.cwd,
          stdio: ["ignore", "pipe", "ignore"],
        }).toString();
        gitFiles = new Set(
          stdout
            .split(/\r?\n/)
            .map((f) => f.trim())
            .filter(Boolean)
        );
      } catch {
        // Not a git repo or git not installed/available
      }

      const filteredFiles = gitFiles
        ? files.filter((f) => gitFiles!.has(f))
        : files;

      const maxFiles = config.context?.maxFilesToIndex ?? 5000;
      const slicedFiles = filteredFiles.length > maxFiles
        ? filteredFiles.slice(0, maxFiles)
        : filteredFiles;

      const activeFiles = new Set<string>();
      let changed = false;
      let i = 0;

      for (const relativePath of slicedFiles) {
        i++;
        if (i % 50 === 0) {
          await new Promise<void>((res) => setImmediate(res));
        }
        // Resolve absolute path safely to avoid path traversal
        const absolutePath = resolveSafePath(this.cwd, relativePath);
        activeFiles.add(relativePath);

        try {
          const stats = await fsPromises.stat(absolutePath);
          const mtime = stats.mtimeMs;
          const cached = indexData.files[relativePath];

          if (cached && cached.mtime === mtime) {
            continue;
          }

          // Read and parse file symbols & imports
          const content = await fsPromises.readFile(absolutePath, "utf8");
          const { symbols, imports } = this.parseFile(content, relativePath);

          // Chunk file
          const chunks = ASTChunker.chunkFile(content, relativePath, symbols);

          // Embed chunks
          const uncachedTexts: string[] = [];
          for (const chunk of chunks) {
            const cachedVector = embedCache.get(chunk.text);
            if (cachedVector) {
              chunk.vector = cachedVector;
            } else {
              uncachedTexts.push(chunk.text);
            }
          }

          if (uncachedTexts.length > 0 && provider) {
            try {
              const embeddingModel =
                config.models?.embedding || "text-embedding-3-small";
              const vectors = await provider.embed(uncachedTexts, {
                model: embeddingModel,
              });
              let vectorIdx = 0;
              for (const chunk of chunks) {
                if (!chunk.vector) {
                  const vec = vectors[vectorIdx++];
                  if (vec) {
                    chunk.vector = vec;
                    embedCache.set(chunk.text, vec);
                  }
                }
              }
            } catch {
              // Fail silently on embed errors, chunks will only have lexical BM25 coverage
            }
          }

          // Delete old indexing for this file, then save new chunks
          await hybridSearch.deleteByFilePath(relativePath);
          if (chunks.length > 0) {
            await hybridSearch.addDocuments(chunks);
          }

          indexData.files[relativePath] = {
            mtime,
            symbols,
            imports,
          };
          changed = true;
        } catch {
          // Skip file if unreadable
        }
      }

      // Remove files no longer in active workspace list
      for (const relativePath of Object.keys(indexData.files)) {
        if (!activeFiles.has(relativePath)) {
          delete indexData.files[relativePath];
          await hybridSearch.deleteByFilePath(relativePath);
          changed = true;
        }
      }

      if (changed) {
        indexData.indexedAt = new Date().toISOString();
        const parentDir = dirname(this.indexPath);
        if (!existsSync(parentDir)) {
          await fsPromises.mkdir(parentDir, { recursive: true });
        }
        const tmpPath = this.indexPath + ".tmp";
        await fsPromises.writeFile(
          tmpPath,
          JSON.stringify(indexData, null, 2),
          "utf8",
        );
        await fsPromises.rename(tmpPath, this.indexPath);
        embedCache.save();
      }
    } catch {
      // Fail silently to avoid blocking process lifecycle
    }
  }

  /**
   * Helper to query matched symbols by name query.
   */
  public async search(
    query: string,
  ): Promise<Array<SymbolEntry & { filePath: string }>> {
    const results: Array<SymbolEntry & { filePath: string }> = [];
    if (!existsSync(this.indexPath)) {
      return results;
    }

    try {
      const raw = await fsPromises.readFile(this.indexPath, "utf8");
      const parsed = JSON.parse(raw);
      const validated = SymbolIndexSchema.safeParse(parsed);
      if (!validated.success) return results;

      const lowercaseQuery = query.toLowerCase();
      for (const [filePath, fileData] of Object.entries(validated.data.files)) {
        const fileIndex = fileData as FileIndex;
        for (const sym of fileIndex.symbols) {
          if (sym.name.toLowerCase().includes(lowercaseQuery)) {
            results.push({
              ...sym,
              filePath,
            });
          }
        }
      }
    } catch {
      // Fail silently
    }

    return results;
  }

  /**
   * Generates a dense, token-efficient map of the codebase landmarks (Repo Map)
   * using PageRank weights computed from AST imports and exports.
   */
  public async getRepoMapText(tokenLimit: number = 2048): Promise<string> {
    if (!existsSync(this.indexPath)) {
      return "";
    }

    try {
      const raw = await fsPromises.readFile(this.indexPath, "utf8");
      const parsed = JSON.parse(raw);
      const validated = SymbolIndexSchema.safeParse(parsed);
      if (!validated.success) return "";

      const indexData = validated.data;
      const allFiles = new Set(Object.keys(indexData.files));

      // 1. Build package map from workspace package.json files
      const packageMap: Record<string, string> = {};
      try {
        const packageJsonFiles = await glob("**/package.json", {
          cwd: this.cwd,
          ignore: ["**/node_modules/**", "**/dist/**"],
          onlyFiles: true,
          absolute: false,
          suppressErrors: true,
        });
        for (const relPath of packageJsonFiles) {
          try {
            const absPath = resolveSafePath(this.cwd, relPath);
            const content = await fsPromises.readFile(absPath, "utf8");
            const pkg = JSON.parse(content);
            if (pkg.name && typeof pkg.name === "string") {
              packageMap[pkg.name] = dirname(relPath).replace(/\\/g, "/");
            }
          } catch {
            // Ignore
          }
        }
      } catch {
        // Ignore
      }

      // 2. Resolve imports for each file to construct the dependency graph edges
      const resolvedEdges = new Map<string, Set<string>>();
      for (const [filePath, fileData] of Object.entries(indexData.files)) {
        const edges = new Set<string>();
        const imports = fileData.imports || [];
        for (const imp of imports) {
          const resolved = this.resolveImportPath(
            filePath,
            imp,
            allFiles,
            packageMap,
          );
          if (resolved && resolved !== filePath) {
            edges.add(resolved);
          }
        }
        resolvedEdges.set(filePath, edges);
      }

      // 3. Compute PageRank scores
      const pageRanks = this.computePageRank(indexData.files, resolvedEdges);

      // Sort files by PageRank score descending
      const sortedFiles = Object.keys(indexData.files).sort((a, b) => {
        const scoreA = pageRanks[a] || 0;
        const scoreB = pageRanks[b] || 0;
        return scoreB - scoreA;
      });

      // 4. Greedily select files to display in detail based on token budget
      const detailedFiles = new Set<string>();
      const outlineFiles = new Set<string>();
      const estTokens = (s: string) => Math.ceil(s.length / 4);

      // Build the base mapping: initially, all files are in "simple" (just paths) mode.
      // We will iteratively upgrade the highest ranked files.
      let currentOutput = "";
      const buildOutput = () => {
        let out = "## Codebase Landmark Map\n\n";

        // Show detailed landmarks first
        const detailedList = sortedFiles.filter((f) => detailedFiles.has(f));
        if (detailedList.length > 0) {
          out += "### Detailed Landmarks\n";
          for (const file of detailedList) {
            const fileData = indexData.files[file];
            out += `${file}:\n`;
            if (fileData.symbols && fileData.symbols.length > 0) {
              for (const sym of fileData.symbols) {
                out += `  - ${sym.type} ${sym.name} (line ${sym.line})\n`;
              }
            } else {
              out += `  (no symbols)\n`;
            }
          }
          out += "\n";
        }

        // Show outlined landmarks next
        const outlineList = sortedFiles.filter((f) => outlineFiles.has(f));
        if (outlineList.length > 0) {
          out += "### Outlined Landmarks (Classes & Interfaces)\n";
          for (const file of outlineList) {
            const fileData = indexData.files[file];
            out += `${file}:\n`;
            const classAndInterfaceSymbols = fileData.symbols?.filter(
              (s: any) => s.type === "class" || s.type === "interface"
            ) || [];
            if (classAndInterfaceSymbols.length > 0) {
              for (const sym of classAndInterfaceSymbols) {
                out += `  - ${sym.type} ${sym.name} (line ${sym.line})\n`;
              }
            } else {
              out += `  (outline: no classes or interfaces)\n`;
            }
          }
          out += "\n";
        }

        // Show remaining files as simple paths
        const simpleFiles = sortedFiles.filter(
          (f) => !detailedFiles.has(f) && !outlineFiles.has(f)
        );
        if (simpleFiles.length > 0) {
          out += "### Other Files\n";
          for (const file of simpleFiles) {
            out += `${file}\n`;
          }
        }
        return out;
      };

      // Greedily upgrade top files
      for (const file of sortedFiles) {
        // Try detailed first
        detailedFiles.add(file);
        let nextOutput = buildOutput();
        if (estTokens(nextOutput) <= tokenLimit) {
          currentOutput = nextOutput;
          continue;
        }

        // Exceeds, degrade to outline
        detailedFiles.delete(file);
        outlineFiles.add(file);
        nextOutput = buildOutput();
        if (estTokens(nextOutput) <= tokenLimit) {
          currentOutput = nextOutput;
          continue;
        }

        // Exceeds, fallback to simple
        outlineFiles.delete(file);
      }

      // If even no files upgraded fits (very small tokenLimit), fall back to simple output
      if (!currentOutput) {
        currentOutput = buildOutput();
      }

      return currentOutput;
    } catch {
      return "";
    }
  }

  private resolveImportPath(
    fromFile: string,
    importPath: string,
    allFiles: Set<string>,
    packageMap: Record<string, string>,
  ): string | null {
    if (!importPath.startsWith(".") && !importPath.startsWith("/")) {
      let matchedPackageKey = "";
      for (const pkgName of Object.keys(packageMap)) {
        if (importPath === pkgName || importPath.startsWith(pkgName + "/")) {
          if (pkgName.length > matchedPackageKey.length) {
            matchedPackageKey = pkgName;
          }
        }
      }

      if (matchedPackageKey) {
        const pkgDir = packageMap[matchedPackageKey];
        const remainder = importPath.substring(matchedPackageKey.length);
        const targetPath = join(pkgDir, remainder).replace(/\\/g, "/");

        const candidates = [
          targetPath,
          targetPath + ".ts",
          targetPath + ".tsx",
          targetPath + ".js",
          targetPath + ".jsx",
          targetPath + ".d.ts",
          join(targetPath, "src/index.ts").replace(/\\/g, "/"),
          join(targetPath, "src/index.tsx").replace(/\\/g, "/"),
          join(targetPath, "src/index.js").replace(/\\/g, "/"),
          join(targetPath, "src/main.ts").replace(/\\/g, "/"),
          join(targetPath, "src/main.tsx").replace(/\\/g, "/"),
          join(targetPath, "index.ts").replace(/\\/g, "/"),
          join(targetPath, "index.tsx").replace(/\\/g, "/"),
          join(targetPath, "index.js").replace(/\\/g, "/"),
        ];

        for (const cand of candidates) {
          const cleanCand = cand.replace(/^\.\//, "");
          if (allFiles.has(cleanCand)) {
            return cleanCand;
          }
        }
      }
      return null;
    }

    const fromDir = dirname(fromFile);
    const joined = join(fromDir, importPath);
    const normalized = joined.replace(/\\/g, "/");

    const candidates = [
      normalized,
      normalized + ".ts",
      normalized + ".tsx",
      normalized + ".js",
      normalized + ".jsx",
      normalized + ".d.ts",
      join(normalized, "index.ts").replace(/\\/g, "/"),
      join(normalized, "index.tsx").replace(/\\/g, "/"),
      join(normalized, "index.js").replace(/\\/g, "/"),
      join(normalized, "index.jsx").replace(/\\/g, "/"),
    ];

    for (const cand of candidates) {
      const cleanCand = cand.replace(/^\.\//, "");
      if (allFiles.has(cleanCand)) {
        return cleanCand;
      }
    }

    return null;
  }

  private computePageRank(
    files: Record<string, any>,
    resolvedEdges: Map<string, Set<string>>,
  ): Record<string, number> {
    const nodes = Object.keys(files);
    const N = nodes.length;
    if (N === 0) return {};

    let pr: Record<string, number> = {};
    for (const node of nodes) {
      pr[node] = 1 / N;
    }

    const damping = 0.85;
    const maxIterations = 20;
    const tol = 1e-4;

    const incoming: Record<string, string[]> = {};
    for (const node of nodes) {
      incoming[node] = [];
    }

    const outgoingCount: Record<string, number> = {};
    for (const node of nodes) {
      const targets = resolvedEdges.get(node) || new Set();
      outgoingCount[node] = targets.size;
      for (const target of targets) {
        if (incoming[target] !== undefined) {
          incoming[target].push(node);
        }
      }
    }

    for (let iter = 0; iter < maxIterations; iter++) {
      const nextPr: Record<string, number> = {};
      for (const node of nodes) {
        nextPr[node] = 0;
      }

      let danglingSum = 0;
      for (const node of nodes) {
        if (outgoingCount[node] === 0) {
          danglingSum += pr[node];
        }
      }

      for (const node of nodes) {
        let sum = (1 - damping) / N + (damping * danglingSum) / N;

        for (const source of incoming[node]) {
          const outDegree = outgoingCount[source];
          if (outDegree > 0) {
            sum += damping * (pr[source] / outDegree);
          }
        }

        nextPr[node] = sum;
      }

      let diff = 0;
      for (const node of nodes) {
        diff += Math.abs(nextPr[node] - pr[node]);
      }

      pr = nextPr;
      if (diff < tol) {
        break;
      }
    }

    return pr;
  }

  private parseFile(
    content: string,
    filePath: string,
  ): { symbols: SymbolEntry[]; imports: string[] } {
    const symbols: SymbolEntry[] = [];
    const imports: string[] = [];
    try {
      const sourceFile = ts.createSourceFile(
        filePath,
        content,
        ts.ScriptTarget.Latest,
        true,
      );

      const visit = (node: ts.Node) => {
        if (ts.isImportDeclaration(node)) {
          const specifier = node.moduleSpecifier;
          if (ts.isStringLiteral(specifier)) {
            imports.push(specifier.text);
          }
        } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
          const specifier = node.moduleSpecifier;
          if (ts.isStringLiteral(specifier)) {
            imports.push(specifier.text);
          }
        } else if (ts.isClassDeclaration(node) && node.name) {
          symbols.push({
            name: node.name.text,
            type: "class",
            line:
              sourceFile.getLineAndCharacterOfPosition(node.getStart()).line +
              1,
          });
        } else if (ts.isInterfaceDeclaration(node) && node.name) {
          symbols.push({
            name: node.name.text,
            type: "interface",
            line:
              sourceFile.getLineAndCharacterOfPosition(node.getStart()).line +
              1,
          });
        } else if (ts.isTypeAliasDeclaration(node) && node.name) {
          symbols.push({
            name: node.name.text,
            type: "type",
            line:
              sourceFile.getLineAndCharacterOfPosition(node.getStart()).line +
              1,
          });
        } else if (ts.isFunctionDeclaration(node) && node.name) {
          symbols.push({
            name: node.name.text,
            type: "function",
            line:
              sourceFile.getLineAndCharacterOfPosition(node.getStart()).line +
              1,
          });
        } else if (ts.isVariableStatement(node)) {
          const isExported = node.modifiers?.some(
            (m) => m.kind === ts.SyntaxKind.ExportKeyword,
          );
          if (isExported) {
            for (const decl of node.declarationList.declarations) {
              if (ts.isIdentifier(decl.name)) {
                symbols.push({
                  name: decl.name.text,
                  type: "constant",
                  line:
                    sourceFile.getLineAndCharacterOfPosition(decl.getStart())
                      .line + 1,
                });
              }
            }
          }
        }
        ts.forEachChild(node, visit);
      };

      visit(sourceFile);
    } catch {
      // Fallback
    }

    return { symbols, imports };
  }
}
