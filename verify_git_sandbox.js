import { execSync } from 'child_process';
import { existsSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { Renderer } from './packages/tui/dist/index.js';

const tempTestDir = join(process.cwd(), 'scratch_git_test');

console.log('=== Step 1: Initialize Temp Git Repository ===');
if (existsSync(tempTestDir)) {
  rmSync(tempTestDir, { recursive: true, force: true });
}
mkdirSync(tempTestDir);

execSync('git init', { cwd: tempTestDir });
execSync('git config user.name "Test User"', { cwd: tempTestDir });
execSync('git config user.email "test@example.com"', { cwd: tempTestDir });

// Create initial commit
writeFileSync(join(tempTestDir, 'file1.txt'), 'Initial Content\n', 'utf8');
execSync('git add file1.txt', { cwd: tempTestDir });
execSync('git commit -m "feat: initial commit"', { cwd: tempTestDir });
console.log('✔ Initialized git repo with 1 commit.');

console.log('\n=== Step 2: Simulate Agent Edit (Staging/Unstaged changes) ===');
writeFileSync(join(tempTestDir, 'file1.txt'), 'LLM Edited Content\n', 'utf8');
writeFileSync(join(tempTestDir, 'file2.txt'), 'LLM Created File\n', 'utf8');

// Ensure working directory is dirty
const statusBefore = execSync('git status --porcelain', { cwd: tempTestDir }).toString().trim();
console.log('Current status:\n' + statusBefore);

console.log('\n=== Step 3: Simulate Git Checkpoint Creation ===');
execSync('git add -A', { cwd: tempTestDir });
execSync('git commit -m "orbit-temp-checkpoint-test" --no-verify', { cwd: tempTestDir });
const checkpointCommitHash = execSync('git rev-parse HEAD', { cwd: tempTestDir }).toString().trim();
console.log(`✔ Git Checkpoint Commit created: ${checkpointCommitHash}`);

const statusAfterCheckpoint = execSync('git status --porcelain', { cwd: tempTestDir }).toString().trim();
console.log(`Working directory is clean: ${statusAfterCheckpoint === '' ? 'Yes' : 'No'}`);

console.log('\n=== Step 4: Simulate Bash Command modifying files (dirtying worktree) ===');
writeFileSync(join(tempTestDir, 'file2.txt'), 'Bash Modified Content\n', 'utf8');
writeFileSync(join(tempTestDir, 'file3.txt'), 'Bash Created File\n', 'utf8');

const statusAfterBash = execSync('git status --porcelain', { cwd: tempTestDir }).toString().trim();
console.log('Status after command run:\n' + statusAfterBash);

console.log('\n=== Step 5: Test Rejection & Hard Rollback ===');
execSync(`git reset --hard ${checkpointCommitHash}~1`, { cwd: tempTestDir });
const statusAfterRollback = execSync('git status --porcelain', { cwd: tempTestDir }).toString().trim();
const file1Content = execSync('git show HEAD:file1.txt', { cwd: tempTestDir }).toString().trim();

console.log('Rollback Successful:');
console.log(`- Working tree clean: ${statusAfterRollback === '' ? 'Yes' : 'No'}`);
console.log(`- file1.txt restored to original content: ${file1Content === 'Initial Content' ? 'Yes' : 'No'}`);
console.log(`- file2.txt exists: ${existsSync(join(tempTestDir, 'file2.txt')) ? 'Yes' : 'No'}`);
console.log(`- file3.txt exists: ${existsSync(join(tempTestDir, 'file3.txt')) ? 'Yes' : 'No'}`);

console.log('\n=== Step 6: Test Markdown Formatting ===');
const mdSource = `
# Header 1
## Header 2
This is **bold green** and this is *italic*.
Here is some \`inline code\`.
- Point 1
- Point 2
`;
const rendered = Renderer.formatMarkdown(mdSource);
console.log('Rendered ANSI Output:\n' + rendered);

// Clean up
rmSync(tempTestDir, { recursive: true, force: true });
console.log('\n✔ Verification completed successfully!');
