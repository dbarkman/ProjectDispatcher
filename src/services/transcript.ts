import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

const RUNS_DIR = join(homedir(), 'Development', '.tasks', 'artifacts', 'runs');

export interface TranscriptEntry {
  type: 'text' | 'tool_call' | 'tool_result' | 'error' | 'unknown';
  content: string;
}

/**
 * Read the raw transcript for an agent run.
 */
export async function readTranscript(runId: string): Promise<string> {
  const path = join(RUNS_DIR, `${runId}.log`);
  return readFile(path, 'utf8');
}

/**
 * Parse a raw transcript into structured entries. The transcript is
 * output from `claude -p --output-format text` (or stream-json), so
 * it's a mix of text output and tool call logs.
 *
 * For text output format, the transcript is just the assistant's text
 * response. For stream-json format, each line is a JSON object with a
 * type field. We handle both gracefully.
 */
export function parseTranscript(raw: string): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  const lines = raw.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Try to parse as JSON (stream-json format)
    if (trimmed.startsWith('{')) {
      try {
        const parsed = JSON.parse(trimmed) as Record<string, unknown>;
        if (parsed.type === 'tool_call') {
          entries.push({ type: 'tool_call', content: JSON.stringify(parsed, null, 2) });
        } else if (parsed.type === 'tool_result') {
          entries.push({ type: 'tool_result', content: JSON.stringify(parsed, null, 2) });
        } else if (parsed.type === 'error') {
          entries.push({ type: 'error', content: String(parsed.message ?? parsed.error ?? trimmed) });
        } else {
          entries.push({ type: 'text', content: JSON.stringify(parsed, null, 2) });
        }
        continue;
      } catch {
        // Not valid JSON — treat as text
      }
    }

    entries.push({ type: 'text', content: trimmed });
  }

  return entries;
}

/**
 * Format parsed transcript entries into a human-readable string.
 */
export function formatTranscript(entries: TranscriptEntry[]): string {
  return entries
    .map((e) => {
      switch (e.type) {
        case 'tool_call':
          return `[TOOL CALL]\n${e.content}`;
        case 'tool_result':
          return `[TOOL RESULT]\n${e.content}`;
        case 'error':
          return `[ERROR] ${e.content}`;
        default:
          return e.content;
      }
    })
    .join('\n\n');
}
