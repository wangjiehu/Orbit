import { basename, isAbsolute, join, resolve } from "path";
import { promises as fsPromises } from "fs";
import { homedir } from "os";
import { estimateTokenCount } from "@orbit-build/shared";
import { ConfigLoader } from "@orbit-build/config";
import { ActiveSkill, ContextPack, SkillSummary } from "./types.js";
import { ProjectIndexer } from "./ProjectIndexer.js";
import { FileSummarizer } from "./FileSummarizer.js";
import { SymbolIndexer, getEmbeddingProvider } from "./SymbolIndexer.js";
import { HybridSearch } from "./HybridSearch.js";
import { ReferencesRetriever } from "./ReferencesRetriever.js";

export class ContextPackBuilder {
  private indexer: ProjectIndexer;
  private summarizer: FileSummarizer;
  private skillsCache:
    | {
        key: string;
        loadedAt: number;
        skills: Array<SkillSummary & { content: string }>;
      }
    | undefined;

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
    const config = ConfigLoader.loadSync(this.cwd);
    const skillsPromise = this.loadSkills(config, userQuery);

    // Check if query contains @codebase
    let codebaseContextPromise: Promise<string | undefined> =
      Promise.resolve(undefined);
    if (userQuery && userQuery.includes("@codebase")) {
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

    const [
      projectIndex,
      projectInstructions,
      codebaseContext,
      packedFiles,
      skills,
    ] = await Promise.all([
      projectIndexPromise,
      projectInstructionsPromise,
      codebaseContextPromise,
      packedFilesPromise,
      skillsPromise,
    ]);

    const payload = JSON.stringify({
      projectIndex,
      projectInstructions,
      packedFiles,
      codebaseContext,
      skillsIndex: skills.index,
      activeSkills: skills.active,
    });
    const usedEstimate = estimateTokenCount(payload);

    return {
      projectInstructions,
      projectIndex,
      skillsIndex: skills.index,
      activeSkills: skills.active,
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

  private async loadSkills(
    config: any,
    userQuery?: string,
  ): Promise<{ index: SkillSummary[]; active: ActiveSkill[] }> {
    const skillsConfig = {
      enabled: true,
      directories: [".orbit/skills", ".agents/skills"],
      activation: "auto",
      maxActive: 3,
      maxSkillBytes: 24000,
      ...(config.skills || {}),
    };
    if (skillsConfig.enabled === false) {
      return { index: [], active: [] };
    }

    const directories = Array.isArray(skillsConfig.directories)
      ? skillsConfig.directories
      : [];
    if (directories.length === 0) {
      return { index: [], active: [] };
    }

    const resolvedDirs = directories.map((dir: string) =>
      this.resolveSkillDirectory(dir),
    );
    const cacheKey = JSON.stringify({
      dirs: resolvedDirs,
      maxBytes: skillsConfig.maxSkillBytes || 24000,
    });
    const now = Date.now();
    if (
      this.skillsCache &&
      this.skillsCache.key === cacheKey &&
      now - this.skillsCache.loadedAt < 30000
    ) {
      const active = this.selectActiveSkills(
        this.skillsCache.skills,
        userQuery,
        skillsConfig,
      );
      return {
        index: this.skillsCache.skills.map(
          ({ content: _content, ...skill }) => skill,
        ),
        active,
      };
    }

    const loaded: Array<SkillSummary & { content: string }> = [];
    for (const dir of resolvedDirs) {
      const skillFiles = await this.findSkillFiles(dir);
      for (const filePath of skillFiles) {
        try {
          const raw = await fsPromises.readFile(filePath, "utf8");
          const content = raw.slice(0, skillsConfig.maxSkillBytes || 24000);
          loaded.push(this.parseSkillFile(filePath, content));
        } catch {
          // Ignore unreadable skill files.
        }
      }
    }

    const unique = new Map<string, SkillSummary & { content: string }>();
    for (const skill of loaded) {
      const key = skill.name.toLowerCase();
      if (!unique.has(key)) {
        unique.set(key, skill);
      }
    }
    const skills = Array.from(unique.values()).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    this.skillsCache = { key: cacheKey, loadedAt: now, skills };

    return {
      index: skills.map(({ content: _content, ...skill }) => skill),
      active: this.selectActiveSkills(skills, userQuery, skillsConfig),
    };
  }

  private resolveSkillDirectory(dir: string): string {
    if (dir.startsWith("~/") || dir === "~") {
      return resolve(homedir(), dir.slice(2));
    }
    return isAbsolute(dir) ? resolve(dir) : resolve(this.cwd, dir);
  }

  private async findSkillFiles(root: string): Promise<string[]> {
    const results: string[] = [];
    const queue = [root];
    const ignored = new Set(["node_modules", ".git", "dist", "build"]);

    while (queue.length > 0 && results.length < 200) {
      const dir = queue.shift()!;
      let entries: Array<{
        name: string;
        isDirectory(): boolean;
        isFile(): boolean;
      }>;
      try {
        entries = await fsPromises.readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (entry.isDirectory()) {
          if (!ignored.has(entry.name)) {
            queue.push(join(dir, entry.name));
          }
        } else if (entry.isFile() && entry.name === "SKILL.md") {
          results.push(join(dir, entry.name));
        }
      }
    }
    return results;
  }

  private parseSkillFile(
    filePath: string,
    content: string,
  ): SkillSummary & { content: string } {
    const frontmatter = content.match(/^---\n([\s\S]*?)\n---/);
    const metadata = frontmatter?.[1] || "";
    const name =
      metadata.match(/^name:\s*["']?(.+?)["']?\s*$/m)?.[1]?.trim() ||
      basename(resolve(filePath, ".."));
    const description =
      metadata.match(/^description:\s*["']?(.+?)["']?\s*$/m)?.[1]?.trim() ||
      content
        .split(/\r?\n/)
        .find((line) => line.trim() && !line.startsWith("---"))
        ?.trim() ||
      "";

    return {
      name,
      description,
      path: filePath.replace(/\\/g, "/"),
      content,
    };
  }

  private selectActiveSkills(
    skills: Array<SkillSummary & { content: string }>,
    userQuery: string | undefined,
    skillsConfig: any,
  ): ActiveSkill[] {
    const query = (userQuery || "").toLowerCase();
    if (!query || (skillsConfig.maxActive || 3) <= 0) {
      return [];
    }

    const scored = skills
      .map((skill) => {
        const name = skill.name.toLowerCase();
        const explicit =
          query.includes(`$${name}`) ||
          query.includes(`skill:${name}`) ||
          query.includes(`技能:${name}`);
        let score = explicit ? 100 : 0;
        if (skillsConfig.activation !== "explicit") {
          const haystack = `${name} ${skill.description.toLowerCase()}`;
          for (const token of query.split(/[\s,.;:!?，。；：！？、/\\]+/)) {
            if (token.length >= 3 && haystack.includes(token)) {
              score += 1;
            }
          }
          if (name.length >= 3 && query.includes(name)) {
            score += 3;
          }
        }
        return { skill, score };
      })
      .filter((item) => item.score > 0)
      .sort(
        (a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name),
      )
      .slice(0, skillsConfig.maxActive || 3);

    return scored.map(({ skill }) => ({
      name: skill.name,
      description: skill.description,
      path: skill.path,
      content: skill.content,
    }));
  }
}
