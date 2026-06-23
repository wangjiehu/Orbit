import { join } from "path";
import { promises as fsPromises } from "fs";
import { estimateTokenCount } from "@orbit-build/shared";
import { ConfigLoader } from "@orbit-build/config";
import { ContextPack } from "./types.js";
import { ProjectIndexer } from "./ProjectIndexer.js";
import { FileSummarizer } from "./FileSummarizer.js";
import { SymbolIndexer, getEmbeddingProvider } from "./SymbolIndexer.js";
import { HybridSearch } from "./HybridSearch.js";
import { ReferencesRetriever } from "./ReferencesRetriever.js";

export class ContextPackBuilder {
  private indexer: ProjectIndexer;
  private summarizer: FileSummarizer;

  constructor(private cwd: string) {
    this.indexer = new ProjectIndexer(cwd);
    this.summarizer = new FileSummarizer(cwd);
  }

  public async build(
    relevantFiles: Array<{ path: string; reason: string; readOnly?: boolean }>,
    userQuery?: string,
  ): Promise<ContextPack> {
    const projectIndexPromise = this.indexer.index();
    const projectInstructionsPromise = this.loadInstructions();

    // Check if query contains @codebase
    let codebaseContextPromise: Promise<string | undefined> =
      Promise.resolve(undefined);
    if (userQuery && userQuery.includes("@codebase")) {
      const config = ConfigLoader.loadSync(this.cwd);
      const cleanQuery = userQuery.replace(/@codebase/g, "").trim();

      codebaseContextPromise = (async () => {
        const symbolIndexer = new SymbolIndexer(this.cwd);
        // Run quick incremental index to make sure RAG has latest files
        await symbolIndexer.index();

        // Get Repo Map Landmark Text
        const repoMap = await symbolIndexer.getRepoMapText(2048);

        // Perform Hybrid Search
        const hybridSearch = new HybridSearch(this.cwd);
        let chunksText = "";
        let referencesText = "";
        try {
          let provider: any = null;
          try {
            provider = getEmbeddingProvider(config);
          } catch {
            // Ignore, provider stays null
          }

          const embedFn = async (texts: string[]) => {
            if (provider && typeof provider.embed === "function") {
              const modelName =
                config.models?.embedding || "text-embedding-3-small";
              return await provider.embed(texts, { model: modelName });
            }
            throw new Error("No embedding provider available");
          };

          const results = await hybridSearch.search(
            cleanQuery || "codebase search",
            embedFn,
            { limit: 5 },
          );
          if (results.length > 0) {
            chunksText = results
              .map((res, idx) => {
                return (
                  `--- Search Match #${idx + 1} (Score: ${res.hybridScore.toFixed(4)}) ---\n` +
                  `${res.text}\n`
                );
              })
              .join("\n");

            // Symbol references graph walk RAG
            const referencedSymbols = new Set<string>();
            for (const res of results) {
              if (res.metadata.symbolName) {
                referencedSymbols.add(res.metadata.symbolName);
              }
            }

            if (referencedSymbols.size > 0) {
              const retriever = new ReferencesRetriever(this.cwd);
              referencesText = await retriever.getReferencesContext(
                Array.from(referencedSymbols),
              );
            }
          } else {
            chunksText = "(No relevant code matches found in search index.)\n";
          }
        } catch (e) {
          chunksText = `(RAG retrieval failed: ${(e as Error).message})\n`;
        }

        return (
          `=== RAG Codebase Search Context for Query: "${cleanQuery}" ===\n` +
          `Use the following relevant code snippets retrieved from the repository to answer questions:\n\n` +
          `${chunksText}\n` +
          `${referencesText}` +
          `=== Codebase Landmark Repo Map ===\n` +
          `${repoMap || "(No landmarks mapped.)"}\n` +
          `================================================================`
        );
      })();
    }

    const packedFilesPromise = Promise.all(
      relevantFiles.map(async (f) => {
        const { summary, excerpt } = await this.summarizer.summarize(f.path);
        return {
          path: f.path,
          reason: f.reason,
          summary,
          excerpt,
          readOnly: f.readOnly,
        };
      }),
    );

    const [projectIndex, projectInstructions, codebaseContext, packedFiles] =
      await Promise.all([
        projectIndexPromise,
        projectInstructionsPromise,
        codebaseContextPromise,
        packedFilesPromise,
      ]);

    const payload = JSON.stringify({
      projectIndex,
      projectInstructions,
      packedFiles,
      codebaseContext,
    });
    const usedEstimate = estimateTokenCount(payload);

    return {
      projectInstructions,
      projectIndex,
      relevantFiles: packedFiles,
      recentChanges: "",
      currentDiff: "",
      previousErrors: "",
      codebaseContext,
      tokenBudget: {
        max: 128000,
        usedEstimate,
      },
    };
  }

  private async loadInstructions(): Promise<string> {
    const candidates = [
      "ORBIT.md",
      ".agents/AGENTS.md",
      "AGENTS.md",
      "CLAUDE.md",
      "RUNE.md",
      ".cursorrules",
      ".copilotrules",
      "README.md",
    ];
    for (const name of candidates) {
      const p = join(this.cwd, ...name.split("/"));
      try {
        const content = await fsPromises.readFile(p, "utf8");
        return content;
      } catch {
        // Ignored
      }
    }
    return "";
  }
}
