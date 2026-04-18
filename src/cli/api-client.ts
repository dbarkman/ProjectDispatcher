// HTTP API client for the CLI. Talks to the running daemon over localhost.
//
// Reads the port from config.json (or uses the default 5757). All responses
// are JSON-parsed. Errors are formatted as user-friendly messages.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_TASKS_DIR } from '../db/index.js';

const CONFIG_PATH = join(DEFAULT_TASKS_DIR, 'config.json');
const DEFAULT_PORT = 5757;

function getPort(): number {
  try {
    if (existsSync(CONFIG_PATH)) {
      const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as Record<string, unknown>;
      const ui = config.ui as Record<string, unknown> | undefined;
      if (ui && typeof ui.port === 'number') return ui.port;
    }
  } catch {
    // Fall through to default
  }
  return DEFAULT_PORT;
}

const BASE_URL = `http://127.0.0.1:${getPort()}`;

export interface ApiError {
  error: string;
  issues?: Array<{ path: string; message: string }>;
}

/**
 * Make a request to the daemon API. Returns the parsed JSON response.
 * Throws a formatted error on non-2xx responses.
 */
export async function apiRequest<T = unknown>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const url = `${BASE_URL}${path}`;
  const headers: Record<string, string> = {};
  let bodyStr: string | undefined;

  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    bodyStr = JSON.stringify(body);
  }

  let response: Response;
  try {
    response = await fetch(url, { method, headers, body: bodyStr });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('ECONNREFUSED')) {
      throw new Error('Daemon is not running. Start it with: dispatch daemon start');
    }
    throw new Error(`Failed to connect to daemon: ${msg}`);
  }

  const text = await response.text();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
    }
    // Non-JSON 2xx response — unexpected from the PD API (which always
    // returns JSON), but handle gracefully instead of silently returning
    // a string where the caller expects T. (Final Review H-02)
    throw new Error(`Unexpected non-JSON response (HTTP ${response.status}): ${text.slice(0, 200)}`);
  }

  if (!response.ok) {
    const apiErr = data as ApiError;
    let message = `HTTP ${response.status}: ${apiErr.error ?? 'Unknown error'}`;
    if (apiErr.issues) {
      message += '\n' + apiErr.issues.map((i) => `  ${i.path}: ${i.message}`).join('\n');
    }
    throw new Error(message);
  }

  return data as T;
}

export const api = {
  get: <T = unknown>(path: string) => apiRequest<T>('GET', path),
  post: <T = unknown>(path: string, body?: unknown) => apiRequest<T>('POST', path, body),
  patch: <T = unknown>(path: string, body?: unknown) => apiRequest<T>('PATCH', path, body),
  delete: <T = unknown>(path: string) => apiRequest<T>('DELETE', path),
};
