import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Database } from 'better-sqlite3';
import { openDatabase } from '../../src/db/index.js';
import { runMigrations } from '../../src/db/migrate.js';
import { seedBuiltins } from '../../src/db/seed.js';
import { createProject } from '../../src/db/queries/projects.js';
import { loadConfig } from '../../src/config.js';
import { createLogger } from '../../src/logger.js';
import { Scheduler } from '../../src/daemon/scheduler.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let db: Database;
let scheduler: Scheduler;
let tmpDir: string;

beforeEach(() => {
  db = openDatabase(':memory:');
  runMigrations(db);
  seedBuiltins(db);

  tmpDir = mkdtempSync(join(tmpdir(), 'pd-sched-test-'));
  const config = loadConfig(join(tmpDir, 'nonexistent.json'));
  const logger = createLogger(join(tmpDir, 'logs'));
  scheduler = new Scheduler(db, config, logger);
});

afterEach(() => {
  scheduler.stop();
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('Scheduler.start()', () => {
  it('loads active projects with heartbeat rows', () => {
    createProject(db, { name: 'Alpha', path: '/a', projectTypeId: 'software-dev' });
    createProject(db, { name: 'Beta', path: '/b', projectTypeId: 'software-dev' });

    scheduler.start();

    const stateA = scheduler.getProjectState(
      (db.prepare("SELECT id FROM projects WHERE name = 'Alpha'").get() as { id: string }).id,
    );
    const stateB = scheduler.getProjectState(
      (db.prepare("SELECT id FROM projects WHERE name = 'Beta'").get() as { id: string }).id,
    );

    expect(stateA).not.toBeNull();
    expect(stateA!.isScheduled).toBe(true);
    expect(stateB).not.toBeNull();
    expect(stateB!.isScheduled).toBe(true);
  });

  it('returns projectCount=0 when no projects exist', () => {
    scheduler.start();
    // No error, no scheduled projects
  });

  it('skips archived projects', () => {
    const p = createProject(db, { name: 'Gone', path: '/gone', projectTypeId: 'software-dev' });
    db.prepare("UPDATE projects SET status = 'archived' WHERE id = ?").run(p.id);

    scheduler.start();

    const state = scheduler.getProjectState(p.id);
    expect(state).not.toBeNull();
    expect(state!.isScheduled).toBe(false);
  });

  it('skips missing projects', () => {
    const p = createProject(db, { name: 'Lost', path: '/lost', projectTypeId: 'software-dev' });
    db.prepare("UPDATE projects SET status = 'missing' WHERE id = ?").run(p.id);

    scheduler.start();

    const state = scheduler.getProjectState(p.id);
    expect(state).not.toBeNull();
    expect(state!.isScheduled).toBe(false);
  });

  it('repairs active projects with missing heartbeat rows', () => {
    const p = createProject(db, { name: 'Orphan', path: '/orphan', projectTypeId: 'software-dev' });
    db.prepare('DELETE FROM project_heartbeats WHERE project_id = ?').run(p.id);

    scheduler.start();

    const state = scheduler.getProjectState(p.id);
    expect(state).not.toBeNull();
    expect(state!.isScheduled).toBe(true);
    expect(state!.consecutiveEmptyChecks).toBe(0);
  });
});

describe('Scheduler.scheduleNewProject()', () => {
  it('schedules a newly created project', () => {
    scheduler.start();

    const p = createProject(db, { name: 'New', path: '/new', projectTypeId: 'software-dev' });
    scheduler.scheduleNewProject(p.id);

    const state = scheduler.getProjectState(p.id);
    expect(state).not.toBeNull();
    expect(state!.isScheduled).toBe(true);
  });

  it('does not crash for a project with no heartbeat row', () => {
    scheduler.start();

    const id = '00000000-0000-0000-0000-000000000000';
    scheduler.scheduleNewProject(id);
    // No error; the method logs a warning and returns gracefully
  });
});

describe('Scheduler.timerCount', () => {
  it('returns 0 when no projects scheduled', () => {
    expect(scheduler.timerCount).toBe(0);
  });

  it('returns count of active project timers', () => {
    createProject(db, { name: 'A', path: '/a', projectTypeId: 'software-dev' });
    createProject(db, { name: 'B', path: '/b', projectTypeId: 'software-dev' });
    scheduler.start();
    expect(scheduler.timerCount).toBe(2);
  });

  it('returns 0 after stop()', () => {
    createProject(db, { name: 'C', path: '/c', projectTypeId: 'software-dev' });
    scheduler.start();
    expect(scheduler.timerCount).toBe(1);
    scheduler.stop();
    expect(scheduler.timerCount).toBe(0);
  });
});

describe('Scheduler.resetProject()', () => {
  it('resets heartbeat to near-immediate', () => {
    const p = createProject(db, { name: 'Reset', path: '/reset', projectTypeId: 'software-dev' });
    scheduler.start();

    scheduler.resetProject(p.id);

    const state = scheduler.getProjectState(p.id);
    expect(state).not.toBeNull();
    expect(state!.isScheduled).toBe(true);
    expect(state!.consecutiveEmptyChecks).toBe(0);
    expect(state!.lastWakeAt).toBeGreaterThan(0);
  });
});
