import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { readFile, writeFile, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { reloadConfig, DEFAULT_CONFIG_PATH } from '../../config.js';
import { CLAUDE_MODELS } from '../../types.js';
import type { Config } from '../../config.schema.js';

const aiConfigBody = z.object({
  auth_method: z.enum(['oauth', 'api_key', 'custom']),
  api_key: z.string().optional(),
  base_url: z.string().url().optional(),
  default_model: z.enum(CLAUDE_MODELS).optional(),
});

const testBody = z.object({
  auth_method: z.enum(['oauth', 'api_key', 'custom']),
  api_key: z.string().optional(),
  base_url: z.string().url().optional(),
});

export async function aiConfigRoutes(
  app: FastifyInstance,
  getConfig: () => Config,
  setConfig: (c: Config) => void,
  configPath: string = DEFAULT_CONFIG_PATH,
): Promise<void> {

  // GET /api/config/ai/detect-oauth — check if ~/.claude/ has tokens
  app.get('/api/config/ai/detect-oauth', async () => {
    const claudeDir = join(homedir(), '.claude');
    const hasDir = existsSync(claudeDir);
    if (!hasDir) return { detected: false };

    const credentialsPath = join(claudeDir, 'credentials.json');
    const hasCredentials = existsSync(credentialsPath);
    return { detected: hasCredentials };
  });

  // POST /api/config/ai — save AI config + run connection test
  app.post('/api/config/ai', async (request, reply) => {
    const body = aiConfigBody.parse(request.body);

    if (body.auth_method === 'api_key' && !body.api_key) {
      return reply.status(400).send({ error: 'API key required for api_key auth method' });
    }
    if (body.auth_method === 'custom' && (!body.api_key || !body.base_url)) {
      return reply.status(400).send({ error: 'API key and base URL required for custom auth method' });
    }

    const testResult = await runConnectionTest(
      body.auth_method,
      getConfig().claude_cli.binary_path,
      body.api_key,
      body.base_url,
    );

    if (!testResult.success) {
      return reply.status(400).send({
        error: 'Connection test failed',
        detail: testResult.error,
      });
    }

    let current: Record<string, unknown>;
    try {
      const text = await readFile(configPath, 'utf8');
      current = JSON.parse(text) as Record<string, unknown>;
    } catch {
      current = {};
    }

    const aiSection: Record<string, unknown> = {
      provider: 'claude',
      auth_method: body.auth_method,
      default_model: body.default_model ?? 'claude-sonnet-4-6',
    };
    if (body.api_key) aiSection.api_key = body.api_key;
    if (body.base_url) aiSection.base_url = body.base_url;

    current.ai = aiSection;

    await writeFile(configPath, JSON.stringify(current, null, 2) + '\n', 'utf8');
    await chmod(configPath, 0o600);

    const reloaded = reloadConfig(configPath);
    setConfig(reloaded);

    return { status: 'ok', model: testResult.model };
  });

  // POST /api/config/ai/test — connection test without saving
  app.post('/api/config/ai/test', async (_request, reply) => {
    const body = testBody.parse(_request.body);

    if (body.auth_method === 'api_key' && !body.api_key) {
      return reply.status(400).send({ error: 'API key required for api_key auth method' });
    }
    if (body.auth_method === 'custom' && (!body.api_key || !body.base_url)) {
      return reply.status(400).send({ error: 'API key and base URL required for custom auth method' });
    }

    const result = await runConnectionTest(
      body.auth_method,
      getConfig().claude_cli.binary_path,
      body.api_key,
      body.base_url,
    );

    if (!result.success) {
      return reply.status(400).send({
        error: 'Connection test failed',
        detail: result.error,
      });
    }

    return { status: 'ok', model: result.model };
  });
}

interface TestResult {
  success: boolean;
  model?: string;
  error?: string;
}

function runConnectionTest(
  authMethod: string,
  claudeBinary: string,
  apiKey?: string,
  baseUrl?: string,
): Promise<TestResult> {
  return new Promise((resolve) => {
    const env: Record<string, string> = { ...process.env } as Record<string, string>;

    if (authMethod === 'api_key' && apiKey) {
      env.ANTHROPIC_API_KEY = apiKey;
    } else if (authMethod === 'custom') {
      if (apiKey) env.ANTHROPIC_API_KEY = apiKey;
      if (baseUrl) env.ANTHROPIC_BASE_URL = baseUrl;
    }

    const child = execFile(
      claudeBinary,
      ['-p', 'respond with OK', '--output-format', 'text'],
      { env, timeout: 30_000 },
      (error, stdout, stderr) => {
        if (error) {
          const msg = stderr?.trim() || error.message;
          if (msg.includes('auth') || msg.includes('401') || msg.includes('token')) {
            resolve({ success: false, error: 'Authentication failed. Check your credentials.' });
          } else if (msg.includes('ENOTFOUND') || msg.includes('ECONNREFUSED')) {
            resolve({ success: false, error: 'Cannot reach endpoint. Check your base URL.' });
          } else {
            resolve({ success: false, error: msg.slice(0, 500) });
          }
          return;
        }

        const output = stdout.trim();
        resolve({ success: true, model: output.includes('OK') ? undefined : output });
      },
    );

    void child;
  });
}
