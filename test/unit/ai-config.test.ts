import { describe, it, expect } from 'vitest';
import { configSchema } from '../../src/config.schema.js';

describe('AI config schema', () => {
  it('defaults ai section with no auth_method', () => {
    const result = configSchema.parse({});
    expect(result.ai).toBeDefined();
    expect(result.ai.provider).toBe('claude');
    expect(result.ai.auth_method).toBeUndefined();
    expect(result.ai.default_model).toBe('claude-opus-4-7');
  });

  it('accepts oauth auth_method', () => {
    const result = configSchema.parse({ ai: { auth_method: 'oauth' } });
    expect(result.ai.auth_method).toBe('oauth');
  });

  it('accepts api_key auth_method with key', () => {
    const result = configSchema.parse({
      ai: { auth_method: 'api_key', api_key: 'sk-ant-test123' },
    });
    expect(result.ai.auth_method).toBe('api_key');
    expect(result.ai.api_key).toBe('sk-ant-test123');
  });

  it('accepts custom auth_method with base_url + key', () => {
    const result = configSchema.parse({
      ai: {
        auth_method: 'custom',
        api_key: 'sk-test',
        base_url: 'https://proxy.example.com/v1',
      },
    });
    expect(result.ai.auth_method).toBe('custom');
    expect(result.ai.base_url).toBe('https://proxy.example.com/v1');
  });

  it('rejects invalid auth_method', () => {
    const result = configSchema.safeParse({ ai: { auth_method: 'magic' } });
    expect(result.success).toBe(false);
  });

  it('rejects invalid base_url', () => {
    const result = configSchema.safeParse({
      ai: { auth_method: 'custom', base_url: 'not-a-url' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects invalid default_model', () => {
    const result = configSchema.safeParse({
      ai: { default_model: 'gpt-4' },
    });
    expect(result.success).toBe(false);
  });

  it('allows api_key and base_url to be omitted', () => {
    const result = configSchema.parse({ ai: { auth_method: 'oauth' } });
    expect(result.ai.api_key).toBeUndefined();
    expect(result.ai.base_url).toBeUndefined();
  });
});
