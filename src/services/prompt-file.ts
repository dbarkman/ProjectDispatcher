import { readFile, writeFile, mkdir, rename, unlink } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';

/** Root directory for prompt files. Resolved once at import time. */
const PROMPTS_DIR = resolve(join(homedir(), 'Development', '.tasks', 'prompts'));

/**
 * Validate and resolve a prompt filename to an absolute path inside
 * PROMPTS_DIR. Rejects traversal attempts, absolute paths, and anything
 * that resolves outside the prompts directory.
 *
 * Security: This is the enforcement point for system_prompt_path
 * traversal (Review #1 watchpoint, implemented in MVP-09, extracted
 * to a shared service in MVP-14). The seed test also verifies
 * containment at test time.
 */
export function resolvePromptPath(filename: string): string {
  if (filename.includes('..') || filename.startsWith('/') || filename.startsWith('\\')) {
    throw new Error(`Invalid prompt filename: ${filename}`);
  }
  const full = resolve(PROMPTS_DIR, filename);
  if (!full.startsWith(PROMPTS_DIR + sep)) {
    throw new Error(`Prompt path escapes prompts directory: ${filename}`);
  }
  return full;
}

/**
 * Read a prompt file by agent type ID. Returns the file content as a
 * string. Throws if the file doesn't exist (ENOENT) or the path is
 * invalid.
 */
export async function readPromptFile(agentTypeId: string): Promise<string> {
  const path = resolvePromptPath(`${agentTypeId}.md`);
  return readFile(path, 'utf8');
}

/**
 * Write a prompt file atomically. Writes to a temporary file in the same
 * directory, then renames. This prevents corruption if the process crashes
 * mid-write — the file is either the old version or the new version,
 * never a partial write.
 */
export async function writePromptFile(agentTypeId: string, content: string): Promise<void> {
  const path = resolvePromptPath(`${agentTypeId}.md`);
  await mkdir(dirname(path), { recursive: true });

  // Write to a temp file in the same directory (same filesystem = atomic rename)
  const tmpPath = join(dirname(path), `.${randomUUID()}.tmp`);
  try {
    await writeFile(tmpPath, content, 'utf8');
    await rename(tmpPath, path);
  } catch (err) {
    // Clean up the temp file if rename failed (best-effort)
    try {
      await unlink(tmpPath);
    } catch {
      // Orphaned .tmp in PROMPTS_DIR is harmless
    }
    throw err;
  }
}

/**
 * Resolve the full filesystem path for a prompt file.
 */
export function promptFilePath(agentTypeId: string): string {
  return resolvePromptPath(`${agentTypeId}.md`);
}

/**
 * Ensure a prompt file exists. If missing, writes the default content.
 * If the file already exists, does nothing (preserves user edits).
 */
export async function ensurePromptFileExists(
  agentTypeId: string,
  defaultContent: string,
): Promise<void> {
  const path = resolvePromptPath(`${agentTypeId}.md`);
  try {
    await readFile(path, 'utf8');
    // File exists — don't overwrite
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      await writePromptFile(agentTypeId, defaultContent);
    } else {
      throw err;
    }
  }
}

export { PROMPTS_DIR };
