import { describe, it, expect } from 'vitest';
import { openDatabase } from '../index.js';
import { runMigrations } from '../migrate.js';
import {
  deriveAbbreviation,
  isAbbreviationTaken,
  uniqueAbbreviation,
  formatTicketDisplayId,
} from './abbreviation.js';

describe('deriveAbbreviation', () => {
  it('CamelCase → uppercase initials lowercased', () => {
    expect(deriveAbbreviation('ProjectDispatcher')).toBe('pd');
    expect(deriveAbbreviation('HandyManagerHub')).toBe('hmh');
    expect(deriveAbbreviation('iOS')).toBe('os'); // 'I' lowercase doesn't count; only O,S → "os"
  });

  it('separator-delimited → first-letter-of-each-word', () => {
    expect(deriveAbbreviation('my-cool-app')).toBe('mca');
    expect(deriveAbbreviation('data lake v2')).toBe('dlv');
    expect(deriveAbbreviation('snake_case_app')).toBe('sca');
  });

  it('single lowercase word → first 3 chars', () => {
    expect(deriveAbbreviation('myproject')).toBe('myp');
    expect(deriveAbbreviation('x')).toBe('x');
  });

  it('empty / whitespace / all-symbols → "p" fallback', () => {
    expect(deriveAbbreviation('')).toBe('p');
    expect(deriveAbbreviation('   ')).toBe('p');
    expect(deriveAbbreviation('!!!')).toBe('p');
  });

  it('strips non-alphanumeric, lowercases', () => {
    expect(deriveAbbreviation('My App!')).toBe('ma');
    expect(deriveAbbreviation('café')).toBe('caf'); // unicode letters dropped, ascii kept
  });

  it('caps abbreviation length at 6 chars', () => {
    expect(deriveAbbreviation('AReallyLongCamelCaseName').length).toBeLessThanOrEqual(6);
  });
});

describe('uniqueAbbreviation + isAbbreviationTaken', () => {
  function setupDb() {
    const db = openDatabase(':memory:');
    runMigrations(db);
    return db;
  }

  it('returns base when free', () => {
    const db = setupDb();
    try {
      expect(uniqueAbbreviation(db, 'pd')).toBe('pd');
    } finally {
      db.close();
    }
  });

  it('appends digit suffix on collision; archived rows ignored', () => {
    const db = setupDb();
    try {
      const now = Date.now();
      db.prepare(
        `INSERT INTO project_types (id, name, is_builtin, created_at, updated_at)
         VALUES ('t', 'Test', 0, ?, ?)`,
      ).run(now, now);
      db.prepare(
        `INSERT INTO projects (id, name, path, project_type_id, status, abbreviation, created_at, updated_at)
         VALUES ('p1', 'A', '/a', 't', 'active', 'pd', ?, ?)`,
      ).run(now, now);
      expect(uniqueAbbreviation(db, 'pd')).toBe('pd2');

      db.prepare(
        `INSERT INTO projects (id, name, path, project_type_id, status, abbreviation, created_at, updated_at)
         VALUES ('p2', 'B', '/b', 't', 'active', 'pd2', ?, ?)`,
      ).run(now, now);
      expect(uniqueAbbreviation(db, 'pd')).toBe('pd3');

      // Archive p1; "pd" is free again.
      db.prepare("UPDATE projects SET status='archived' WHERE id='p1'").run();
      expect(uniqueAbbreviation(db, 'pd')).toBe('pd');
    } finally {
      db.close();
    }
  });

  it('isAbbreviationTaken excludes self when excludeProjectId given', () => {
    const db = setupDb();
    try {
      const now = Date.now();
      db.prepare(
        `INSERT INTO project_types (id, name, is_builtin, created_at, updated_at)
         VALUES ('t', 'Test', 0, ?, ?)`,
      ).run(now, now);
      db.prepare(
        `INSERT INTO projects (id, name, path, project_type_id, status, abbreviation, created_at, updated_at)
         VALUES ('p1', 'A', '/a', 't', 'active', 'pd', ?, ?)`,
      ).run(now, now);

      expect(isAbbreviationTaken(db, 'pd')).toBe(true);
      expect(isAbbreviationTaken(db, 'pd', 'p1')).toBe(false); // own row excluded
      expect(isAbbreviationTaken(db, 'pd', 'p-other')).toBe(true);
    } finally {
      db.close();
    }
  });
});

describe('formatTicketDisplayId', () => {
  it('composes <abbr>-<seq>', () => {
    expect(formatTicketDisplayId('pd', 1)).toBe('pd-1');
    expect(formatTicketDisplayId('hmh', 42)).toBe('hmh-42');
  });
});
