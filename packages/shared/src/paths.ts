import { resolve, normalize, isAbsolute } from 'path';

export function normalizePath(p: string): string {
  return normalize(p).replace(/\\/g, '/');
}

export function checkWorkspaceBoundary(workspaceRoot: string, targetPath: string): boolean {
  const normalizedRoot = normalizePath(resolve(workspaceRoot));
  const normalizedTarget = normalizePath(resolve(targetPath));

  if (normalizedTarget === normalizedRoot) {
    return true;
  }
  return normalizedTarget.startsWith(normalizedRoot + '/');
}

export function resolveSafePath(workspaceRoot: string, relativeOrAbsolutePath: string): string {
  const resolvedPath = isAbsolute(relativeOrAbsolutePath)
    ? resolve(relativeOrAbsolutePath)
    : resolve(workspaceRoot, relativeOrAbsolutePath);

  const safe = checkWorkspaceBoundary(workspaceRoot, resolvedPath);
  if (!safe) {
    throw new Error(
      `Path validation failed: "${relativeOrAbsolutePath}" is outside workspace boundary "${workspaceRoot}"`
    );
  }

  return normalizePath(resolvedPath);
}
