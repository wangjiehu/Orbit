import { z } from "zod";
import { readFileSync, writeFileSync } from "fs";
import { resolveSafePath } from "@orbit-build/shared";
import { OrbitTool, ToolContext, ToolResult } from "../types.js";
import type ts from "typescript";

export const EditFileInputSchema = z.object({
  path: z.string(),
  oldText: z.string(),
  newText: z.string(),
  replaceAll: z.boolean().optional(),
});

export type EditFileInput = z.infer<typeof EditFileInputSchema>;

export class EditFileTool implements OrbitTool<EditFileInput, void> {
  name = "edit_file";
  description =
    "Replace oldText with newText inside a file. If replaceAll is false (default), oldText must occur exactly once in the file to prevent accidental edits.";
  inputSchema = EditFileInputSchema;
  risk = "write" as const;

  async execute(
    input: EditFileInput,
    ctx: ToolContext,
  ): Promise<ToolResult<void>> {
    try {
      const safePath = resolveSafePath(ctx.cwd, input.path);
      const originalContent = readFileSync(safePath, "utf8");

      // Normalize line endings
      const fileContent = originalContent.replace(/\r\n/g, "\n");
      const oldTextNorm = input.oldText.replace(/\r\n/g, "\n");
      const newTextNorm = input.newText.replace(/\r\n/g, "\n");

      // 1. Exact Match
      if (fileContent.includes(oldTextNorm)) {
        const parts = fileContent.split(oldTextNorm);
        if (parts.length - 1 > 1 && !input.replaceAll) {
          return {
            ok: false,
            error: `Found multiple occurrences of oldText in "${input.path}". Please make it unique or enable replaceAll.`,
          };
        }
        const updated = fileContent.split(oldTextNorm).join(newTextNorm);
        const writeError = await this.checkAndWrite(input.path, safePath, updated, originalContent);
        if (writeError) return writeError;
        return {
          ok: true,
          display: `Successfully replaced content in ${input.path}`,
        };
      }

      // If exact match fails, perform line-based cascading matches
      const fileLines = fileContent.split("\n");
      const oldLines = oldTextNorm.split("\n");
      const newLines = newTextNorm.split("\n");

      // 2. Whitespace-insensitive Match
      const normOld = oldLines.map((l) => l.replace(/\s+/g, ""));
      const normFile = fileLines.map((l) => l.replace(/\s+/g, ""));
      const M = oldLines.length;
      const N = fileLines.length;

      let matchedIndex: number | null = null;
      let occurrences = 0;

      if (M > 0 && N >= M) {
        for (let i = 0; i <= N - M; i++) {
          let match = true;
          for (let j = 0; j < M; j++) {
            if (normFile[i + j] !== normOld[j]) {
              match = false;
              break;
            }
          }
          if (match) {
            occurrences++;
            matchedIndex = i;
          }
        }
      }

      // 3. Indentation-corrected Match
      if (occurrences === 1 && matchedIndex !== null) {
        const matchedFileLines = fileLines.slice(
          matchedIndex,
          matchedIndex + M,
        );
        const adjustedNewLines = adjustIndentation(
          newLines,
          matchedFileLines,
          oldLines,
        );

        fileLines.splice(matchedIndex, M, ...adjustedNewLines);
        const updated = fileLines.join("\n");
        const writeError = await this.checkAndWrite(input.path, safePath, updated, originalContent);
        if (writeError) return writeError;
        return {
          ok: true,
          display: `Successfully replaced content in ${input.path} (indentation corrected)`,
        };
      }

      if (occurrences > 1 && !input.replaceAll) {
        return {
          ok: false,
          error: `Found multiple whitespace-insensitive occurrences of oldText in "${input.path}". Please provide more surrounding lines.`,
        };
      }

      // 4. Levenshtein Fuzzy Match (similarity threshold > 80%)
      if (M > 0 && N >= M) {
        let bestIndex = -1;
        let bestSim = 0;

        for (let i = 0; i <= N - M; i++) {
          let sumSim = 0;
          for (let j = 0; j < M; j++) {
            sumSim += lineSimilarity(fileLines[i + j], oldLines[j]);
          }
          const avgSim = sumSim / M;
          if (avgSim > bestSim) {
            bestSim = avgSim;
            bestIndex = i;
          }
        }

        if (bestSim >= 0.8) {
          const matchedFileLines = fileLines.slice(bestIndex, bestIndex + M);
          const adjustedNewLines = adjustIndentation(
            newLines,
            matchedFileLines,
            oldLines,
          );

          fileLines.splice(bestIndex, M, ...adjustedNewLines);
          const updated = fileLines.join("\n");
          const writeError = await this.checkAndWrite(input.path, safePath, updated, originalContent);
          if (writeError) return writeError;
          return {
            ok: true,
            display: `Successfully replaced content in ${input.path} (fuzzy matched with ${(bestSim * 100).toFixed(1)}% similarity)`,
          };
        }
      }

      // 5. AST-based Match Fallback
      const astUpdated = await astMatchAndReplace(input.path, fileContent, oldTextNorm, newTextNorm);
      if (astUpdated) {
        const writeError = await this.checkAndWrite(input.path, safePath, astUpdated, originalContent);
        if (writeError) return writeError;
        return {
          ok: true,
          display: `Successfully replaced content in ${input.path} (using AST-based match fallback)`,
        };
      }

      return {
        ok: false,
        error: `Could not find target content "oldText" in "${input.path}", even with fuzzy matching (threshold 80%) or AST symbol matching. Ensure the text matches the file contents.`,
      };
    } catch (e: any) {
      return {
        ok: false,
        error: e.message,
      };
    }
  }

  private async checkAndWrite(
    filePath: string,
    safePath: string,
    updated: string,
    originalContent: string
  ): Promise<ToolResult<void> | null> {
    const syntaxError = await verifySyntax(filePath, updated);
    if (syntaxError) {
      return {
        ok: false,
        error: `Applying this edit would introduce the following syntax error(s). Please correct your replacement block:\n${syntaxError}`,
      };
    }
    const finalContent = originalContent.includes("\r\n")
      ? updated.replace(/\n/g, "\r\n")
      : updated;
    writeFileSync(safePath, finalContent, "utf8");
    return null;
  }
}

async function verifySyntax(filePath: string, content: string): Promise<string | null> {
  const ext = filePath.split(".").pop()?.toLowerCase();
  if (ext === "json") {
    try {
      JSON.parse(content);
      return null;
    } catch (e: any) {
      return `JSON Syntax Error: ${e.message}`;
    }
  }

  if (ext === "js" || ext === "mjs" || ext === "cjs") {
    try {
      const vmModule = await import("vm");
      const vm = vmModule.default || vmModule;
      new vm.Script(content);
      return null;
    } catch (e: any) {
      return `JavaScript Syntax Error: ${e.message}`;
    }
  }

  if (ext === "ts" || ext === "tsx") {
    try {
      const tsModule = await import("typescript");
      const ts = tsModule.default || tsModule;
      const sourceFile = ts.createSourceFile(
        filePath,
        content,
        ts.ScriptTarget.Latest,
        true
      );
      const diagnostics = (sourceFile as any).parseDiagnostics || [];
      if (diagnostics.length > 0) {
        const errors = diagnostics.map((d: any) => {
          const { line, character } = sourceFile.getLineAndCharacterOfPosition(d.start);
          const message = typeof d.messageText === "string" ? d.messageText : d.messageText.messageText;
          return `Line ${line + 1}, Char ${character + 1}: ${message}`;
        });
        return `TypeScript Syntax Error:\n${errors.join("\n")}`;
      }
      return null;
    } catch {
      // Gracefully fall back if typescript package can't be resolved at runtime
      return null;
    }
  }

  if (ext === "py") {
    try {
      const cp = await import("child_process");
      const result = cp.spawnSync("python", ["-c", "import sys; compile(sys.stdin.read(), 'file.py', 'exec')"], {
        input: content,
        encoding: "utf8",
      });
      if (result.status !== 0) {
        return `Python Syntax Error:\n${result.stderr || result.stdout}`;
      }
      return null;
    } catch {
      return null;
    }
  }

  return null;
}

function adjustIndentation(
  newLines: string[],
  matchedFileLines: string[],
  oldLines: string[],
): string[] {
  let fileIndentLen = 0;
  let oldIndentLen = 0;
  let hasIndentation = false;

  for (let j = 0; j < oldLines.length; j++) {
    const oLine = oldLines[j];
    const fLine = matchedFileLines[j];
    if (oLine.trim() && fLine && fLine.trim()) {
      const oInd = oLine.match(/^\s*/)?.[0] || "";
      const fInd = fLine.match(/^\s*/)?.[0] || "";
      if (oInd.length > 0 && fInd.length > 0) {
        oldIndentLen = oInd.length;
        fileIndentLen = fInd.length;
        hasIndentation = true;
        break;
      }
    }
  }

  if (!hasIndentation || oldIndentLen === 0) {
    return newLines;
  }

  const scale = fileIndentLen / oldIndentLen;

  let indentChar = " ";
  for (const line of matchedFileLines) {
    if (line.startsWith("\t")) {
      indentChar = "\t";
      break;
    }
  }

  return newLines.map((line) => {
    if (!line.trim()) return "";
    const currentIndent = line.match(/^\s*/)?.[0] || "";
    const newIndentLen = Math.round(currentIndent.length * scale);
    return indentChar.repeat(newIndentLen) + line.trimStart();
  });
}

function levenshteinDistance(s1: string, s2: string): number {
  const m = s1.length;
  const n = s2.length;
  if (m === 0) return n;
  if (n === 0) return m;

  let prevRow = Array(n + 1);
  let currRow = Array(n + 1);

  for (let j = 0; j <= n; j++) prevRow[j] = j;

  for (let i = 1; i <= m; i++) {
    currRow[0] = i;
    for (let j = 1; j <= n; j++) {
      if (s1[i - 1] === s2[j - 1]) {
        currRow[j] = prevRow[j - 1];
      } else {
        currRow[j] = Math.min(
          prevRow[j] + 1,      // Deletion
          currRow[j - 1] + 1,  // Insertion
          prevRow[j - 1] + 1   // Substitution
        );
      }
    }
    const temp = prevRow;
    prevRow = currRow;
    currRow = temp;
  }
  return prevRow[n];
}

function lineSimilarity(l1: string, l2: string): number {
  const t1 = l1.trim();
  const t2 = l2.trim();
  if (!t1 && !t2) return 1.0;
  if (!t1 || !t2) return 0.0;

  const maxLen = Math.max(t1.length, t2.length);
  // Math Pruning: If difference in lengths is > 20% of maxLen, similarity is guaranteed to be < 80%
  if (Math.abs(t1.length - t2.length) > 0.2 * maxLen) {
    return 0.0;
  }

  const dist = levenshteinDistance(t1, t2);
  return 1.0 - dist / maxLen;
}

async function astMatchAndReplace(
  filePath: string,
  fileContent: string,
  oldText: string,
  newText: string,
): Promise<string | null> {
  const ext = filePath.split(".").pop()?.toLowerCase();
  if (ext !== "ts" && ext !== "tsx" && ext !== "js" && ext !== "jsx" && ext !== "py") {
    return null;
  }

  if (ext === "py") {
    try {
      const cp = await import("child_process");
      const pythonScript = `
import ast
import sys

def run():
    try:
        file_content = sys.argv[1]
        old_text = sys.argv[2]
        new_text = sys.argv[3]
        
        file_tree = ast.parse(file_content)
        old_tree = ast.parse(old_text)
        
        def find_named_decls(tree):
            decls = {}
            for node in ast.walk(tree):
                if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                    decls[node.name] = node
            return decls
            
        old_decls = find_named_decls(old_tree)
        if not old_decls:
            # Try wrapping in class
            wrapped_lines = []
            for l in old_text.splitlines():
                wrapped_lines.append("    " + l)
            wrapped_tree = ast.parse("class Dummy:\\n" + "\\n".join(wrapped_lines))
            old_decls = find_named_decls(wrapped_tree)
            
        if not old_decls:
            sys.exit(1)
            
        primary_name = list(old_decls.keys())[0]
        file_decls = find_named_decls(file_tree)
        
        if primary_name in file_decls:
            target_node = file_decls[primary_name]
            lines = file_content.splitlines(keepends=True)
            start_line = target_node.lineno - 1
            end_line = target_node.end_lineno
            
            # Preserve original indentation
            start_indent = ""
            if start_line < len(lines):
                line_str = lines[start_line]
                start_indent = line_str[:len(line_str) - len(line_str.lstrip())]
                
            indented_new = []
            for l in new_text.splitlines(keepends=True):
                indented_new.append(start_indent + l)
            
            new_lines = lines[:start_line] + ["".join(indented_new)] + lines[end_line:]
            sys.stdout.write("".join(new_lines))
            sys.exit(0)
    except Exception as e:
        sys.exit(2)

if __name__ == "__main__":
    run()
`;
      const result = cp.spawnSync("python", ["-c", pythonScript, fileContent, oldText, newText], {
        encoding: "utf8",
      });
      if (result.status === 0 && result.stdout) {
        return result.stdout;
      }
    } catch {
      // Fallback
    }
    return null;
  }

  try {
    const tsModule = await import("typescript");
    const ts = tsModule.default || tsModule;

    // Parse file content
    const sourceFile = ts.createSourceFile(
      filePath,
      fileContent,
      ts.ScriptTarget.Latest,
      true,
    );

    // Parse oldText
    const oldSourceFile = ts.createSourceFile(
      "oldText.ts",
      oldText,
      ts.ScriptTarget.Latest,
      true,
    );

    const bindParents = (node: ts.Node, parent?: ts.Node) => {
      if (parent) {
        (node as any).parent = parent;
      }
      ts.forEachChild(node, (child) => bindParents(child, node));
    };

    bindParents(sourceFile);
    bindParents(oldSourceFile);

    interface DeclInfo {
      name: string;
      kind: ts.SyntaxKind;
      node: ts.Node;
    }

    const getDeclarations = (node: ts.Node): DeclInfo[] => {
      const decls: DeclInfo[] = [];
      const visit = (n: ts.Node) => {
        if (
          (ts.isClassDeclaration(n) ||
            ts.isInterfaceDeclaration(n) ||
            ts.isFunctionDeclaration(n) ||
            ts.isMethodDeclaration(n) ||
            ts.isTypeAliasDeclaration(n) ||
            ts.isEnumDeclaration(n) ||
            ts.isModuleDeclaration(n)) &&
          n.name &&
          ts.isIdentifier(n.name)
        ) {
          decls.push({ name: n.name.text, kind: n.kind, node: n });
        } else if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name)) {
          decls.push({ name: n.name.text, kind: n.kind, node: n });
        }
        ts.forEachChild(n, visit);
      };
      visit(node);
      return decls;
    };

    const getSymbolPath = (node: ts.Node): string => {
      const pathParts: string[] = [];
      let current: ts.Node | undefined = node;
      while (current) {
        if (
          (ts.isClassDeclaration(current) ||
            ts.isInterfaceDeclaration(current) ||
            ts.isModuleDeclaration(current) ||
            ts.isMethodDeclaration(current) ||
            ts.isFunctionDeclaration(current)) &&
          current.name &&
          ts.isIdentifier(current.name)
        ) {
          pathParts.unshift(current.name.text);
        }
        current = current.parent;
      }
      return pathParts.join(".");
    };

    let oldDecls = getDeclarations(oldSourceFile);
    let isWrapped = false;
    if (oldDecls.length === 0) {
      const wrappedOldSourceFile = ts.createSourceFile(
        "oldText.ts",
        `class Dummy {\n${oldText}\n}`,
        ts.ScriptTarget.Latest,
        true,
      );
      oldDecls = getDeclarations(wrappedOldSourceFile);
      bindParents(wrappedOldSourceFile);
      isWrapped = true;
    }
    if (oldDecls.length === 0) {
      return null;
    }

    const primary = isWrapped
      ? oldDecls.find((d) => !(d.name === "Dummy" && d.kind === ts.SyntaxKind.ClassDeclaration))
      : oldDecls[0];

    if (!primary) {
      return null;
    }

    const fileDecls = getDeclarations(sourceFile);

    // Find nodes matching name and kind
    const candidates = fileDecls.filter(
      (d) => d.name === primary.name && d.kind === primary.kind,
    );

    if (candidates.length === 0) {
      return null;
    }

    let bestMatch: ts.Node | null = null;
    if (candidates.length === 1) {
      bestMatch = candidates[0].node;
    } else {
      // If multiple candidates exist, match parent symbol paths
      const primaryPath = getSymbolPath(primary.node);
      const filtered = candidates.filter((c) => {
        const candidatePath = getSymbolPath(c.node);
        return candidatePath.endsWith(primaryPath);
      });
      if (filtered.length === 1) {
        bestMatch = filtered[0].node;
      }
    }

    if (bestMatch) {
      const start = bestMatch.getStart(sourceFile);
      const end = bestMatch.getEnd();

      const prefix = fileContent.substring(0, start);
      const suffix = fileContent.substring(end);

      // Re-indent newText relative to oldText and target indentation
      const newLines = newText.split("\n");
      const oldLines = oldText.split("\n");
      const matchedNodeText = fileContent.substring(start, end);
      const matchedLines = matchedNodeText.split("\n");

      const adjusted = adjustIndentation(newLines, matchedLines, oldLines);
      return prefix + adjusted.join("\n") + suffix;
    }
  } catch {
    // Fall back
  }

  return null;
}
