import { z } from 'zod';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { OrbitTool, ToolContext, ToolResult } from '../types.js';

export interface ProjectIndex {
  root: string;
  detectedLanguages: string[];
  frameworks: string[];
  packageManager?: 'npm' | 'pnpm' | 'yarn' | 'bun' | 'pip' | 'poetry' | 'cargo' | 'go' | 'maven';
  testCommands: string[];
  lintCommands: string[];
  buildCommands: string[];
  entrypoints: string[];
  importantFiles: string[];
  ignoredFiles: string[];
  generatedAt: string;
}

export const DetectProjectInputSchema = z.object({});

export class DetectProjectTool implements OrbitTool<any, ProjectIndex> {
  name = 'detect_project';
  description =
    'Detect project profile including programming languages, frameworks, package manager, test/lint/build scripts, and main entry files.';
  inputSchema = DetectProjectInputSchema;
  risk = 'read' as const;

  async execute(input: any, ctx: ToolContext): Promise<ToolResult<ProjectIndex>> {
    try {
      const root = ctx.cwd;
      const languages: string[] = [];
      const frameworks: string[] = [];
      let packageManager: ProjectIndex['packageManager'];
      const testCommands: string[] = [];
      const lintCommands: string[] = [];
      const buildCommands: string[] = [];
      const entrypoints: string[] = [];
      const importantFiles: string[] = [];
      const ignoredFiles: string[] = ['node_modules', '.git', 'dist', 'build'];

      if (existsSync(join(root, 'package.json'))) {
        languages.push('javascript', 'typescript');

        if (existsSync(join(root, 'pnpm-lock.yaml'))) packageManager = 'pnpm';
        else if (existsSync(join(root, 'yarn.lock'))) packageManager = 'yarn';
        else if (existsSync(join(root, 'bun.lockb'))) packageManager = 'bun';
        else packageManager = 'npm';

        try {
          const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
          importantFiles.push('package.json');

          const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
          if (allDeps.react) frameworks.push('React');
          if (allDeps.vue) frameworks.push('Vue');
          if (allDeps.next) frameworks.push('Next.js');
          if (allDeps.nuxt) frameworks.push('Nuxt.js');
          if (allDeps.express) frameworks.push('Express');
          if (allDeps.nest) frameworks.push('NestJS');
          if (allDeps.vite) frameworks.push('Vite');

          if (pkg.scripts) {
            if (pkg.scripts.test) testCommands.push(`${packageManager} test`);
            if (pkg.scripts.lint) lintCommands.push(`${packageManager} run lint`);
            if (pkg.scripts.build) buildCommands.push(`${packageManager} run build`);
          }
        } catch (e) {
          // Ignored
        }
      }

      if (
        existsSync(join(root, 'requirements.txt')) ||
        existsSync(join(root, 'pyproject.toml')) ||
        existsSync(join(root, 'poetry.lock'))
      ) {
        languages.push('python');
        if (existsSync(join(root, 'poetry.lock'))) packageManager = 'poetry';
        else packageManager = 'pip';

        if (existsSync(join(root, 'manage.py'))) frameworks.push('Django');
        if (existsSync(join(root, 'main.py'))) entrypoints.push('main.py');

        testCommands.push('pytest');
        importantFiles.push('pyproject.toml');
      }

      if (existsSync(join(root, 'Cargo.toml'))) {
        languages.push('rust');
        packageManager = 'cargo';
        testCommands.push('cargo test');
        buildCommands.push('cargo build');
        importantFiles.push('Cargo.toml');
        if (existsSync(join(root, 'src/main.rs'))) entrypoints.push('src/main.rs');
        if (existsSync(join(root, 'src/lib.rs'))) entrypoints.push('src/lib.rs');
      }

      if (existsSync(join(root, 'go.mod'))) {
        languages.push('go');
        packageManager = 'go';
        testCommands.push('go test ./...');
        buildCommands.push('go build ./...');
        importantFiles.push('go.mod');
        if (existsSync(join(root, 'main.go'))) entrypoints.push('main.go');
      }

      if (existsSync(join(root, 'pom.xml'))) {
        languages.push('java');
        packageManager = 'maven';
        testCommands.push('mvn test');
        buildCommands.push('mvn package');
        importantFiles.push('pom.xml');
      }

      const data: ProjectIndex = {
        root,
        detectedLanguages: Array.from(new Set(languages)),
        frameworks: Array.from(new Set(frameworks)),
        packageManager,
        testCommands,
        lintCommands,
        buildCommands,
        entrypoints,
        importantFiles,
        ignoredFiles,
        generatedAt: new Date().toISOString(),
      };

      return {
        ok: true,
        data,
        display: `Detected Project: ${data.detectedLanguages.join(', ')} project. Frameworks: ${data.frameworks.join(', ') || 'None'}. PM: ${data.packageManager || 'None'}`,
      };
    } catch (e: any) {
      return {
        ok: false,
        error: e.message,
      };
    }
  }
}
