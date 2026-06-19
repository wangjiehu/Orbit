import { writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import picocolors from 'picocolors';

export function runInit(cwd: string): void {
  const target = join(cwd, 'ORBIT.md');
  if (existsSync(target)) {
    console.log(picocolors.yellow(`ORBIT.md already exists in ${cwd}.`));
    return;
  }

  const content = `# Orbit Project Guidelines

This file contains custom developer instructions and rules for the Orbit AI Coding Agent.

## Code Standards
- Keep modifications minimal and precise.
- Preserves existing formatting conventions and docstrings.
- Always verify changes by running appropriate test suites.
`;

  writeFileSync(target, content, 'utf8');
  console.log(picocolors.green(`Successfully initialized ORBIT.md at ${target}`));
}
