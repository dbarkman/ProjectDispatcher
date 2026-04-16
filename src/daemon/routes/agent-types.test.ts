import { describe, it, expect } from 'vitest';
import { ZodError } from 'zod';
import { createAgentTypeBody, updateAgentTypeBody } from './agent-types.js';

// Minimal valid body for createAgentTypeBody — only the required fields.
const validCreate = {
  id: 'test-agent',
  name: 'Test Agent',
  model: 'claude-sonnet-4-6',
  allowed_tools: ['Read', 'Write'],
  permission_mode: 'default' as const,
};

describe('createAgentTypeBody', () => {
  describe('timeout_minutes upper bound', () => {
    it('accepts 1440 (24h boundary)', () => {
      const result = createAgentTypeBody.parse({ ...validCreate, timeout_minutes: 1440 });
      expect(result.timeout_minutes).toBe(1440);
    });

    it('rejects 1441', () => {
      expect(() =>
        createAgentTypeBody.parse({ ...validCreate, timeout_minutes: 1441 }),
      ).toThrow(ZodError);
    });

    it('rejects extremely large values that would overflow setTimeout', () => {
      expect(() =>
        createAgentTypeBody.parse({ ...validCreate, timeout_minutes: Number.MAX_SAFE_INTEGER }),
      ).toThrow(ZodError);
    });

    it('accepts a coerced numeric string at the boundary', () => {
      const result = createAgentTypeBody.parse({ ...validCreate, timeout_minutes: '1440' });
      expect(result.timeout_minutes).toBe(1440);
    });

    it('rejects a coerced numeric string above the boundary', () => {
      expect(() =>
        createAgentTypeBody.parse({ ...validCreate, timeout_minutes: '1441' }),
      ).toThrow(ZodError);
    });
  });

  describe('max_retries upper bound', () => {
    it('accepts 10 (boundary)', () => {
      const result = createAgentTypeBody.parse({ ...validCreate, max_retries: 10 });
      expect(result.max_retries).toBe(10);
    });

    it('rejects 11', () => {
      expect(() =>
        createAgentTypeBody.parse({ ...validCreate, max_retries: 11 }),
      ).toThrow(ZodError);
    });

    it('accepts 0 (lower boundary)', () => {
      const result = createAgentTypeBody.parse({ ...validCreate, max_retries: 0 });
      expect(result.max_retries).toBe(0);
    });
  });

  describe('max_retries rejection paths', () => {
    it('rejects non-numeric string', () => {
      expect(() =>
        createAgentTypeBody.parse({ ...validCreate, max_retries: 'abc' }),
      ).toThrow(ZodError);
    });

    it('rejects negative value', () => {
      expect(() =>
        createAgentTypeBody.parse({ ...validCreate, max_retries: -1 }),
      ).toThrow(ZodError);
    });

    it('rejects negative numeric string', () => {
      expect(() =>
        createAgentTypeBody.parse({ ...validCreate, max_retries: '-3' }),
      ).toThrow(ZodError);
    });

    it('rejects non-integer', () => {
      expect(() =>
        createAgentTypeBody.parse({ ...validCreate, max_retries: 1.5 }),
      ).toThrow(ZodError);
    });
  });
});

describe('updateAgentTypeBody', () => {
  describe('timeout_minutes upper bound', () => {
    it('accepts 1440', () => {
      const result = updateAgentTypeBody.parse({ timeout_minutes: 1440 });
      expect(result.timeout_minutes).toBe(1440);
    });

    it('rejects 1441', () => {
      expect(() => updateAgentTypeBody.parse({ timeout_minutes: 1441 })).toThrow(ZodError);
    });
  });

  describe('max_retries upper bound', () => {
    it('accepts 10', () => {
      const result = updateAgentTypeBody.parse({ max_retries: 10 });
      expect(result.max_retries).toBe(10);
    });

    it('rejects 11', () => {
      expect(() => updateAgentTypeBody.parse({ max_retries: 11 })).toThrow(ZodError);
    });
  });

  describe('max_retries rejection paths', () => {
    it('rejects non-numeric string', () => {
      expect(() => updateAgentTypeBody.parse({ max_retries: 'xyz' })).toThrow(ZodError);
    });

    it('rejects negative value', () => {
      expect(() => updateAgentTypeBody.parse({ max_retries: -2 })).toThrow(ZodError);
    });

    it('rejects non-integer', () => {
      expect(() => updateAgentTypeBody.parse({ max_retries: 2.7 })).toThrow(ZodError);
    });
  });
});
