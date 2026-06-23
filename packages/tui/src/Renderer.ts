const morandi = {
  user: (s: string) => `\x1b[38;2;142;163;175m${s}\x1b[0m`,
  userBold: (s: string) => `\x1b[1;38;2;142;163;175m${s}\x1b[0m`,
  asst: (s: string) => `\x1b[38;2;143;153;129m${s}\x1b[0m`,
  asstBold: (s: string) => `\x1b[1;38;2;143;153;129m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[38;2;142;163;175m${s}\x1b[0m`,
  accent: (s: string) => `\x1b[38;2;200;170;120m${s}\x1b[0m`,
  completed: (s: string) => `\x1b[38;2;135;165;130m${s}\x1b[0m`,
  failed: (s: string) => `\x1b[38;2;180;120;120m${s}\x1b[0m`,
  warn: (s: string) => `\x1b[38;2;180;140;130m${s}\x1b[0m`,
  white: (s: string) => `\x1b[38;2;230;225;215m${s}\x1b[0m`,
  whiteBold: (s: string) => `\x1b[1;38;2;230;225;215m${s}\x1b[0m`,
  gray: (s: string) => `\x1b[38;2;150;150;150m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2;38;2;110;110;110m${s}\x1b[0m`,
};

function syntaxHighlight(line: string): string {
  const commentIdx = line.indexOf("//");
  let codePart = line;
  let commentPart = "";
  if (commentIdx !== -1) {
    codePart = line.substring(0, commentIdx);
    commentPart = line.substring(commentIdx);
  }

  let highlighted = codePart;

  const stringPlaceholders: string[] = [];
  highlighted = highlighted.replace(/(["'`])(.*?)\1/g, (match) => {
    const placeholder = `___STR_PLACEHOLDER_${stringPlaceholders.length}___`;
    stringPlaceholders.push(match);
    return placeholder;
  });

  const keywords = [
    "const", "let", "var", "function", "class", "interface", "type", "import", "from",
    "export", "default", "return", "if", "else", "for", "while", "do", "switch", "case",
    "break", "continue", "async", "await", "public", "private", "protected", "readonly",
    "new", "this", "super", "try", "catch", "finally", "throw", "extends", "implements"
  ];
  const keywordRegex = new RegExp(`\\b(${keywords.join("|")})\\b`, "g");
  highlighted = highlighted.replace(keywordRegex, (match) => {
    return `\x1b[38;2;200;140;180m${match}\x1b[0m`; // Pinkish keyword
  });

  highlighted = highlighted.replace(/\b(\d+)\b/g, (match) => {
    return `\x1b[38;2;200;170;120m${match}\x1b[0m`; // Orange/yellow numbers
  });

  for (let i = 0; i < stringPlaceholders.length; i++) {
    const originalString = stringPlaceholders[i];
    const greenStr = `\x1b[38;2;135;165;130m${originalString}\x1b[0m`;
    highlighted = highlighted.replace(`___STR_PLACEHOLDER_${i}___`, greenStr);
  }

  return highlighted + (commentPart ? `\x1b[38;2;150;150;150m${commentPart}\x1b[0m` : "");
}

export class Renderer {
  public static printHeader(
    sessionId: string,
    model: string,
    cwd: string,
  ): void {
    const sessionShort = sessionId.substring(0, 8);
    const columns = process.stdout.columns || 80;
    const width = Math.min(100, Math.max(40, columns - 4));
    const line = morandi.gray("─".repeat(width));
    console.log(
      "\n  " +
        morandi.asstBold("⚡ Orbit AI Coding Runtime") +
        morandi.gray(" (v0.1.0)"),
    );
    console.log("  " + line);
    console.log(`  🤖 ${morandi.gray("Model")}   : ${morandi.accent(model)}`);
    console.log(
      `  🔑 ${morandi.gray("Session")} : ${morandi.completed(sessionShort)}`,
    );
    console.log(`  📁 ${morandi.gray("Path")}    : ${morandi.dim(cwd)}`);
    console.log("  " + line);
    console.log(
      `  ${morandi.gray("Type")} ${morandi.whiteBold("/help")} ${morandi.gray("to view commands, or type a task to start.")}\n`,
    );
  }

  public static printStatus(label: string, value: string): void {
    console.log(`${morandi.whiteBold(label)}: ${morandi.completed(value)}`);
  }

  public static printStep(msg: string): void {
    console.log(`${morandi.cyan("●")} ${morandi.white(msg)}`);
  }

  public static printThought(thought: string): void {
    if (!thought.trim()) return;
    console.log(`\n🧠 ${morandi.asstBold("Orbit Agent Thinking:")}`);
    const lines = thought.trim().split("\n");
    for (const line of lines) {
      console.log(`   ${morandi.gray(line)}`);
    }
    console.log();
  }

  public static formatMarkdown(text: string): string {
    if (!text) return "";

    const parts = text.split(/```/g);
    let result = "";

    for (let i = 0; i < parts.length; i++) {
      if (i % 2 === 1) {
        const block = parts[i];
        const lines = block.split("\n");
        const lang = lines[0].trim();
        const codeLines =
          lang && /^[a-zA-Z0-9+#-]+$/.test(lang) ? lines.slice(1) : lines;

        while (codeLines.length > 0 && !codeLines[0].trim()) codeLines.shift();
        while (codeLines.length > 0 && !codeLines[codeLines.length - 1].trim())
          codeLines.pop();

        const topBorder = morandi.gray(
          "  ╭── Code " +
            (lang ? `[${lang}] ` : "") +
            "─".repeat(Math.max(5, 48 - (lang ? lang.length + 9 : 0)))
        );
        const bottomBorder = morandi.gray("  ╰" + "─".repeat(57));

        const formattedBlock = codeLines
          .map((l) => {
            return morandi.gray("  │ ") + syntaxHighlight(l);
          })
          .join("\n");

        result +=
          "\n" +
          topBorder +
          "\n" +
          formattedBlock +
          "\n" +
          bottomBorder +
          "\n";
      } else {
        let blockText = parts[i];
        blockText = blockText
          .replace(/\*\*(.*?)\*\*/g, (_, p1) => morandi.completed(p1))
          .replace(/\*(.*?)\*/g, (_, p1) => `\x1b[3m${p1}\x1b[23m`)
          .replace(/`(.*?)`/g, (_, p1) => morandi.accent(p1))
          .replace(
            /^#\s+(.*?)$/gm,
            (_, p1) => `\x1b[1;4;38;2;142;163;175m${p1}\x1b[0m`,
          )
          .replace(/^##\s+(.*?)$/gm, (_, p1) => morandi.userBold(p1))
          .replace(/^###\s+(.*?)$/gm, (_, p1) => morandi.whiteBold(p1))
          .replace(/^-\s+(.*?)$/gm, (_, p1) => `  ${morandi.cyan("●")} ${p1}`)
          .replace(/^\*\s+(.*?)$/gm, (_, p1) => `  ${morandi.cyan("●")} ${p1}`);
        result += blockText;
      }
    }

    return result;
  }
}
