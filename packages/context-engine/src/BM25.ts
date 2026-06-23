import { existsSync, promises as fsPromises } from "fs";
import { join, dirname } from "path";
import { Document } from "./VectorStore.js";
import { getGitBranch } from "@orbit-build/shared";

export function tokenize(text: string): string[] {
  const rawWords = text
    .replace(/([a-z])([A-Z])/g, "$1 $2") // Split camelCase
    .replace(/[^a-zA-Z0-9_\u4e00-\u9fa5]/g, " ") // Keep alphanumeric, underscore, and chinese
    .split(/[\s_]+/)
    .map((w) => w.toLowerCase().trim())
    .filter((w) => w.length > 1);

  const keywords = new Set([
    "if",
    "else",
    "for",
    "while",
    "do",
    "switch",
    "case",
    "break",
    "continue",
    "return",
    "function",
    "class",
    "const",
    "let",
    "var",
    "import",
    "export",
    "from",
    "default",
    "extends",
    "implements",
    "new",
    "this",
    "super",
    "public",
    "private",
    "protected",
    "async",
    "await",
    "try",
    "catch",
    "finally",
    "throw",
    "interface",
    "type",
    "package",
    "namespace",
    "module",
    "typeof",
    "instanceof",
    "void",
    "null",
    "undefined",
    "true",
    "false",
    "boolean",
    "number",
    "string",
    "any",
    "unknown",
    "never",
    "readonly",
    "as",
    "keyof",
  ]);

  return rawWords.filter((w) => !keywords.has(w));
}

interface IndexDoc {
  id: string;
  filePath: string;
  terms: Record<string, number>;
  docLen: number;
}

export class BM25Store {
  private docs: Record<string, IndexDoc> = {};
  private df: Record<string, number> = {};
  private avgdl: number = 0;
  private dbPath: string;
  private loaded = false;

  constructor(private cwd: string) {
    const branchName = getGitBranch(cwd);
    this.dbPath = branchName
      ? join(cwd, ".orbit", "branches", branchName, "bm25_store.json")
      : join(cwd, ".orbit", "bm25_store.json");
  }

  public async addDocuments(documents: Document[]): Promise<void> {
    for (const doc of documents) {
      const tokens = tokenize(doc.text);
      if (tokens.length === 0) continue;

      // Clean old document references from DF if it already exists
      const oldDoc = this.docs[doc.id];
      if (oldDoc) {
        for (const term of Object.keys(oldDoc.terms)) {
          if (this.df[term]) {
            this.df[term]--;
            if (this.df[term] <= 0) delete this.df[term];
          }
        }
      }

      // Calculate term frequencies
      const terms: Record<string, number> = {};
      for (const t of tokens) {
        terms[t] = (terms[t] || 0) + 1;
      }

      // Update document frequencies for new/updated document
      for (const term of Object.keys(terms)) {
        this.df[term] = (this.df[term] || 0) + 1;
      }

      this.docs[doc.id] = {
        id: doc.id,
        filePath: doc.metadata.filePath,
        terms,
        docLen: tokens.length,
      };
    }

    this.recalculateStats();
    await this.save();
  }

  public async deleteByFilePath(filePath: string): Promise<void> {
    let changed = false;
    for (const [id, doc] of Object.entries(this.docs)) {
      if (doc.filePath === filePath) {
        for (const term of Object.keys(doc.terms)) {
          if (this.df[term]) {
            this.df[term]--;
            if (this.df[term] <= 0) delete this.df[term];
          }
        }
        delete this.docs[id];
        changed = true;
      }
    }

    if (changed) {
      this.recalculateStats();
      await this.save();
    }
  }

  public async search(
    query: string,
    limit: number,
  ): Promise<Array<{ id: string; score: number }>> {
    if (Object.keys(this.docs).length === 0) {
      await this.load();
    }

    const qTokens = tokenize(query);
    if (qTokens.length === 0 || Object.keys(this.docs).length === 0) {
      return [];
    }

    const N = Object.keys(this.docs).length;
    const k1 = 1.2;
    const b = 0.75;
    const results: Array<{ id: string; score: number }> = [];

    // Calculate BM25 score for each document
    for (const [id, doc] of Object.entries(this.docs)) {
      let score = 0.0;

      for (const term of qTokens) {
        const dfTerm = this.df[term] || 0;
        if (dfTerm === 0) continue;

        // IDF
        const idf = Math.log(1 + (N - dfTerm + 0.5) / (dfTerm + 0.5));

        // TF
        const tf = doc.terms[term] || 0;
        if (tf === 0) continue;

        // BM25 term score
        const tfScore =
          (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (doc.docLen / this.avgdl)));
        score += idf * tfScore;
      }

      if (score > 0) {
        results.push({ id, score });
      }
    }

    return results.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  private recalculateStats(): void {
    const docList = Object.values(this.docs);
    if (docList.length === 0) {
      this.avgdl = 0;
      return;
    }
    const totalLen = docList.reduce((sum, d) => sum + d.docLen, 0);
    this.avgdl = totalLen / docList.length;
  }

  public async save(): Promise<void> {
    try {
      const parentDir = dirname(this.dbPath);
      if (!existsSync(parentDir)) {
        await fsPromises.mkdir(parentDir, { recursive: true });
      }
      const data = {
        docs: this.docs,
        df: this.df,
        avgdl: this.avgdl,
      };
      await fsPromises.writeFile(
        this.dbPath,
        JSON.stringify(data, null, 2),
        "utf8",
      );
    } catch {
      // Ignore
    }
  }

  public async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    if (!existsSync(this.dbPath)) {
      this.docs = {};
      this.df = {};
      this.avgdl = 0;
      return;
    }
    try {
      const raw = await fsPromises.readFile(this.dbPath, "utf8");
      const parsed = JSON.parse(raw);
      this.docs = parsed.docs || {};
      this.df = parsed.df || {};
      this.avgdl = parsed.avgdl || 0;
    } catch {
      this.docs = {};
      this.df = {};
      this.avgdl = 0;
    }
  }

  public async clear(): Promise<void> {
    this.docs = {};
    this.df = {};
    this.avgdl = 0;
    this.loaded = false;
    if (existsSync(this.dbPath)) {
      try {
        await fsPromises.unlink(this.dbPath);
      } catch {
        // Ignore
      }
    }
  }
}
