// Heartbeat scheduler for Project Dispatcher.
//
// Manages per-project timers that fire heartbeats. Each heartbeat checks
// the project's agent columns for unclaimed tickets, spawns agents for
// any work found, and applies exponential backoff on empty checks.
//
// Design invariants:
//   - Every active project has exactly one timer in the `timers` map.
//   - A timer fires → handleHeartbeat runs → scheduleNext sets the next timer.
//   - The backoff sequence: 5min → 10min → 20min → ... → 24hr cap.
//   - Reset to 5min when: human assigns to agent column, or agent finds work.
//   - The scheduler does NOT queue work. If concurrency limits are hit, excess
//     tickets stay in the column and are picked up on the next heartbeat.
//
// Failure modes considered:
//   - handleHeartbeat throws → caught, logged, project rescheduled with backoff
//   - runAgent throws (concurrency limit) → caught per-ticket, logged, skip
//   - DB read fails → caught, logged, project rescheduled with backoff
//   - Daemon restarts with stale state → recovery.ts cleans up before start()

import type { Database } from 'better-sqlite3';
import type { Logger } from 'pino';
import type { Config } from '../config.schema.js';
import { runAgent } from './agent-runner.js';

interface HeartbeatRow {
  project_id: string;
  next_check_at: number;
  consecutive_empty_checks: number;
  last_wake_at: number | null;
  last_work_found_at: number | null;
}

interface ProjectTypeColumnRow {
  column_id: string;
  agent_type_id: string;
}

export interface HeartbeatState {
  projectId: string;
  nextCheckAt: number;
  consecutiveEmptyChecks: number;
  lastWakeAt: number | null;
  lastWorkFoundAt: number | null;
  isScheduled: boolean;
}

export class Scheduler {
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private db: Database;
  private config: Config;
  private logger: Logger;

  constructor(db: Database, config: Config, logger: Logger) {
    this.db = db;
    this.config = config;
    this.logger = logger.child({ component: 'scheduler' });
  }

  /**
   * Start the scheduler: load all active projects and schedule their
   * first heartbeat based on the DB state.
   */
  start(): void {
    const projects = this.db
      .prepare(
        `SELECT ph.* FROM project_heartbeats ph
         JOIN projects p ON p.id = ph.project_id
         WHERE p.status = 'active'`,
      )
      .all() as HeartbeatRow[];

    for (const hb of projects) {
      this.scheduleNext(hb.project_id, hb.next_check_at);
    }

    this.logger.info({ projectCount: projects.length }, 'Scheduler started');
  }

  /**
   * Stop the scheduler: clear all timers. Does NOT modify DB state.
   */
  stop(): void {
    for (const [projectId, timer] of this.timers) {
      clearTimeout(timer);
      this.logger.debug({ projectId }, 'Timer cleared');
    }
    this.timers.clear();
    this.logger.info('Scheduler stopped');
  }

  /**
   * Reset a project's heartbeat to near-immediate. Called when:
   *   - A human moves a ticket to an agent column
   *   - An agent finds work (cascade reset)
   *   - POST /api/projects/:id/wake
   */
  resetProject(projectId: string): void {
    const now = Date.now();
    const nextCheck = now + 5000; // 5 seconds

    this.db
      .prepare(
        `UPDATE project_heartbeats
         SET next_check_at = ?, consecutive_empty_checks = 0, last_wake_at = ?, updated_at = ?
         WHERE project_id = ?`,
      )
      .run(nextCheck, now, now, projectId);

    this.scheduleNext(projectId, nextCheck);
    this.logger.info({ projectId }, 'Heartbeat reset to immediate');
  }

  /**
   * Get the current heartbeat state for a project (for UI display).
   */
  getProjectState(projectId: string): HeartbeatState | null {
    const row = this.db
      .prepare('SELECT * FROM project_heartbeats WHERE project_id = ?')
      .get(projectId) as HeartbeatRow | undefined;
    if (!row) return null;

    return {
      projectId: row.project_id,
      nextCheckAt: row.next_check_at,
      consecutiveEmptyChecks: row.consecutive_empty_checks,
      lastWakeAt: row.last_wake_at,
      lastWorkFoundAt: row.last_work_found_at,
      isScheduled: this.timers.has(projectId),
    };
  }

  /**
   * Schedule the next heartbeat for a project. If a timer already
   * exists for this project, it's replaced.
   */
  private scheduleNext(projectId: string, nextCheckAt: number): void {
    // Clear any existing timer for this project
    const existing = this.timers.get(projectId);
    if (existing) clearTimeout(existing);

    const delayMs = Math.max(0, nextCheckAt - Date.now());

    const timer = setTimeout(() => {
      this.timers.delete(projectId);
      this.handleHeartbeat(projectId).catch((err) => {
        this.logger.error({ err, projectId }, 'Heartbeat handler failed');
        // Reschedule with backoff even on failure — don't leave the project
        // without a timer, and don't retry immediately on repeated failures.
        this.applyBackoff(projectId);
      });
    }, delayMs);

    this.timers.set(projectId, timer);
  }

  /**
   * The heartbeat tick handler. Fires when a project's timer goes off.
   *
   * Logic (from DESIGN.md §10.3):
   *   1. Load the project's agent columns.
   *   2. For each agent column, find unclaimed tickets.
   *   3. If work found: spawn agents, reset heartbeat.
   *   4. If no work: increment empty checks, apply backoff.
   */
  private async handleHeartbeat(projectId: string): Promise<void> {
    const project = this.db
      .prepare('SELECT id, project_type_id, status FROM projects WHERE id = ?')
      .get(projectId) as { id: string; project_type_id: string; status: string } | undefined;

    if (!project || project.status !== 'active') {
      this.logger.debug({ projectId }, 'Project not active — skipping heartbeat');
      return;
    }

    // Get all agent columns for this project type (columns with an agent_type_id)
    const agentColumns = this.db
      .prepare(
        `SELECT column_id, agent_type_id FROM project_type_columns
         WHERE project_type_id = ? AND agent_type_id IS NOT NULL
         ORDER BY "order"`,
      )
      .all(project.project_type_id) as ProjectTypeColumnRow[];

    let foundWork = false;

    for (const col of agentColumns) {
      // Find unclaimed tickets in this agent column
      const tickets = this.db
        .prepare(
          `SELECT id FROM tickets
           WHERE project_id = ? AND "column" = ? AND claimed_by_run_id IS NULL
           ORDER BY created_at`,
        )
        .all(projectId, col.column_id) as Array<{ id: string }>;

      if (tickets.length === 0) continue;
      foundWork = true;

      this.logger.info(
        { projectId, column: col.column_id, agentType: col.agent_type_id, ticketCount: tickets.length },
        'Work found — spawning agents',
      );

      // Spawn agents for each ticket (up to concurrency cap)
      for (const ticket of tickets) {
        try {
          // runAgent enforces per-project and global concurrency limits —
          // if we hit the cap, it throws and we skip the remaining tickets.
          // They'll be picked up on the next heartbeat.
          await runAgent(
            { projectId, agentTypeId: col.agent_type_id, ticketId: ticket.id },
            this.db,
            this.config,
            this.logger,
          );
        } catch (err) {
          this.logger.warn(
            { err, projectId, ticketId: ticket.id, agentType: col.agent_type_id },
            'Failed to spawn agent — likely concurrency limit',
          );
          break; // Don't try more tickets if we're at the limit
        }
      }
    }

    if (foundWork) {
      this.resetToBase(projectId);
    } else {
      this.applyBackoff(projectId);
    }
  }

  /**
   * Reset heartbeat to the base interval (work was found).
   */
  private resetToBase(projectId: string): void {
    const now = Date.now();
    const baseMs = this.config.heartbeat.base_interval_seconds * 1000;
    const nextCheck = now + baseMs;

    this.db
      .prepare(
        `UPDATE project_heartbeats
         SET next_check_at = ?, consecutive_empty_checks = 0,
             last_work_found_at = ?, updated_at = ?
         WHERE project_id = ?`,
      )
      .run(nextCheck, now, now, projectId);

    this.scheduleNext(projectId, nextCheck);
  }

  /**
   * Apply exponential backoff (no work found).
   * Formula: min(base * multiplier^count, max)
   */
  private applyBackoff(projectId: string): void {
    const now = Date.now();
    const hb = this.db
      .prepare('SELECT consecutive_empty_checks FROM project_heartbeats WHERE project_id = ?')
      .get(projectId) as { consecutive_empty_checks: number } | undefined;

    const emptyChecks = (hb?.consecutive_empty_checks ?? 0) + 1;
    const baseMs = this.config.heartbeat.base_interval_seconds * 1000;
    const maxMs = this.config.heartbeat.max_interval_seconds * 1000;
    const multiplier = this.config.heartbeat.backoff_multiplier;

    const intervalMs = Math.min(baseMs * Math.pow(multiplier, emptyChecks), maxMs);
    const nextCheck = now + intervalMs;

    this.db
      .prepare(
        `UPDATE project_heartbeats
         SET next_check_at = ?, consecutive_empty_checks = ?, updated_at = ?
         WHERE project_id = ?`,
      )
      .run(nextCheck, emptyChecks, now, projectId);

    this.scheduleNext(projectId, nextCheck);

    this.logger.debug(
      { projectId, emptyChecks, intervalMs, nextCheckIn: `${Math.round(intervalMs / 1000)}s` },
      'Backoff applied',
    );
  }
}
