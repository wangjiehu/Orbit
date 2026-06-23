import { existsSync, promises as fsPromises } from "fs";
import { join, dirname } from "path";
import { getGitBranch } from "@orbit-build/shared";

export interface Document {
  id: string;
  text: string;
  vector?: number[];
  metadata: {
    filePath: string;
    symbolName?: string;
    symbolType?: string;
    startLine: number;
    endLine: number;
  };
}

export interface VectorStore {
  addDocuments(docs: Document[]): Promise<void>;
  search(
    queryVector: number[],
    limit: number,
  ): Promise<Array<Document & { score: number }>>;
  deleteByFilePath(filePath: string): Promise<void>;
  save(): Promise<void>;
  load(): Promise<void>;
  clear(): Promise<void>;
}

export interface DBHeader {
  modelName: string;
  dimension: number;
  updatedAt: string;
}

export class JSVectorStore implements VectorStore {
  private documents: Document[] = [];
  private dbPath: string;
  private header: DBHeader | null = null;
  private loaded = false;

  constructor(
    private cwd: string,
    private modelName?: string,
  ) {
    const branchName = getGitBranch(cwd);
    this.dbPath = branchName
      ? join(cwd, ".orbit", "branches", branchName, "vector_store.json")
      : join(cwd, ".orbit", "vector_store.json");
  }

  public async addDocuments(docs: Document[]): Promise<void> {
    if (docs.length > 0 && docs[0].vector) {
      const inputDim = docs[0].vector.length;
      const existingDoc = this.documents.find(
        (d) => d.vector && d.vector.length > 0,
      );
      if (
        (existingDoc &&
          existingDoc.vector &&
          existingDoc.vector.length !== inputDim) ||
        (this.header && this.header.dimension !== inputDim)
      ) {
        this.documents = [];
      }
      this.header = {
        modelName: this.modelName || "default",
        dimension: inputDim,
        updatedAt: new Date().toISOString(),
      };
    }

    // Overwrite docs with same IDs or add new ones
    const docMap = new Map(this.documents.map((d) => [d.id, d]));
    for (const doc of docs) {
      docMap.set(doc.id, doc);
    }
    this.documents = Array.from(docMap.values());
    await this.save();
  }

  public async deleteByFilePath(filePath: string): Promise<void> {
    const originalLength = this.documents.length;
    this.documents = this.documents.filter(
      (doc) => doc.metadata.filePath !== filePath,
    );
    if (this.documents.length !== originalLength) {
      await this.save();
    }
  }

  public async search(
    queryVector: number[],
    limit: number,
  ): Promise<Array<Document & { score: number }>> {
    if (this.documents.length === 0) {
      await this.load();
    }

    if (this.documents.length > 0) {
      const existingDoc = this.documents.find(
        (d) => d.vector && d.vector.length > 0,
      );
      if (
        (existingDoc &&
          existingDoc.vector &&
          existingDoc.vector.length !== queryVector.length) ||
        (this.header && this.header.dimension !== queryVector.length)
      ) {
        await this.clear();
        return [];
      }
    }

    const results: Array<Document & { score: number }> = [];
    for (const doc of this.documents) {
      if (!doc.vector || doc.vector.length !== queryVector.length) {
        continue;
      }
      const score = this.cosineSimilarity(queryVector, doc.vector);
      results.push({
        ...doc,
        score,
      });
    }

    // Sort descending by score
    return results.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  public async save(): Promise<void> {
    try {
      const parentDir = dirname(this.dbPath);
      if (!existsSync(parentDir)) {
        await fsPromises.mkdir(parentDir, { recursive: true });
      }
      const dataToSave = {
        header: this.header,
        documents: this.documents,
      };
      const tmpPath = this.dbPath + ".tmp";
      await fsPromises.writeFile(
        tmpPath,
        JSON.stringify(dataToSave, null, 2),
        "utf8",
      );
      await fsPromises.rename(tmpPath, this.dbPath);
    } catch {
      // Fail silently to avoid blocking parent operations
    }
  }

  public async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    if (!existsSync(this.dbPath)) {
      this.documents = [];
      this.header = null;
      return;
    }
    try {
      const raw = await fsPromises.readFile(this.dbPath, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && "documents" in parsed) {
        this.documents = parsed.documents || [];
        this.header = parsed.header || null;
      } else {
        // Fallback for old simple array format
        this.documents = Array.isArray(parsed) ? parsed : [];
        this.header = null;
      }

      // Check model name mismatch
      if (
        this.modelName &&
        this.header &&
        this.header.modelName &&
        this.header.modelName !== this.modelName
      ) {
        await this.clear();
      }
    } catch {
      this.documents = [];
      this.header = null;
    }
  }

  public async clear(): Promise<void> {
    this.documents = [];
    this.header = null;
    this.loaded = false;
    if (existsSync(this.dbPath)) {
      try {
        await fsPromises.unlink(this.dbPath);
      } catch {
        // Ignore
      }
    }
  }

  /**
   * Helper to calculate Cosine Similarity between two vectors.
   */
  private cosineSimilarity(vecA: number[], vecB: number[]): number {
    let dotProduct = 0.0;
    let normA = 0.0;
    let normB = 0.0;

    for (let i = 0; i < vecA.length; i++) {
      dotProduct += vecA[i] * vecB[i];
      normA += vecA[i] * vecA[i];
      normB += vecB[i] * vecB[i];
    }

    if (normA === 0.0 || normB === 0.0) {
      return 0.0;
    }

    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }
}
