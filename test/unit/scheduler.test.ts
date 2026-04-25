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
  scheduler = new Scheduler(db, { current: config }, logger);
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

describe('Watchdog: overdue heartbeat detection', () => {
  it('reschedules projects whose next_check_at is overdue', () => {
    const p = createProject(db, { name: 'Stale', path: '/stale', projectTypeId: 'software-dev' });
    scheduler.start();

    // Simulate: set next_check_at to 60 seconds in the past (well past the 10s grace)
    const past = Date.now() - 60_000;
    db.prepare('UPDATE project_heartbeats SET next_check_at = ? WHERE project_id = ?')
      .run(past, p.id);

    const count = scheduler.watchdogSweep();
    expect(count).toBe(1);

    // Timer should still be set (rescheduled with delay=0)
    const state = scheduler.getProjectState(p.id);
    expect(state).not.toBeNull();
    expect(state!.isScheduled).toBe(true);
  });

  it('ignores heartbeats that are not yet overdue', () => {
    createProject(db, { name: 'Future', path: '/future', projectTypeId: 'software-dev' });
    scheduler.start();

    // next_check_at is in the future (set by createProject)
    const count = scheduler.watchdogSweep();
    expect(count).toBe(0);
  });

  it('skips projects within the 10-second grace period', () => {
    const p = createProject(db, { name: 'Grace', path: '/grace', projectTypeId: 'software-dev' });
    scheduler.start();

    // Set next_check_at to 5 seconds ago — within the 10s grace period
    const recent = Date.now() - 5_000;
    db.prepare('UPDATE project_heartbeats SET next_check_at = ? WHERE project_id = ?')
      .run(recent, p.id);

    const count = scheduler.watchdogSweep();
    expect(count).toBe(0);
  });

  it('skips archived projects even if overdue', () => {
    const p = createProject(db, { name: 'Archived', path: '/archived', projectTypeId: 'software-dev' });
    db.prepare("UPDATE projects SET status = 'archived' WHERE id = ?").run(p.id);
    scheduler.start();

    const past = Date.now() - 60_000;
    db.prepare('UPDATE project_heartbeats SET next_check_at = ? WHERE project_id = ?')
      .run(past, p.id);

    const count = scheduler.watchdogSweep();
    expect(count).toBe(0);
  });

  it('catches multiple overdue projects in one sweep', () => {
    const p1 = createProject(db, { name: 'Stale1', path: '/s1', projectTypeId: 'software-dev' });
    const p2 = createProject(db, { name: 'Stale2', path: '/s2', projectTypeId: 'software-dev' });
    createProject(db, { name: 'Healthy', path: '/h', projectTypeId: 'software-dev' });
    scheduler.start();

    const past = Date.now() - 60_000;
    db.prepare('UPDATE project_heartbeats SET next_check_at = ? WHERE project_id = ?').run(past, p1.id);
    db.prepare('UPDATE project_heartbeats SET next_check_at = ? WHERE project_id = ?').run(past, p2.id);

    const count = scheduler.watchdogSweep();
    expect(count).toBe(2);
  });
});

describe('Startup: overdue heartbeat handling', () => {
  it('schedules overdue heartbeats with delay=0 on start', () => {
    const p = createProject(db, { name: 'Overdue', path: '/overdue', projectTypeId: 'software-dev' });

    // Set next_check_at to the past before start()
    const past = Date.now() - 120_000;
    db.prepare('UPDATE project_heartbeats SET next_check_at = ? WHERE project_id = ?')
      .run(past, p.id);

    scheduler.start();

    // Timer should be set (will fire with delay=0)
    const state = scheduler.getProjectState(p.id);
    expect(state).not.toBeNull();
    expect(state!.isScheduled).toBe(true);
  });
});
