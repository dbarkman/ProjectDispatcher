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
import { randomUUID } from 'node:crypto';
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
   *
   * Repairs missing heartbeat rows first — if a project is active but
   * has no project_heartbeats row (e.g. the row was lost to a failed
   * transaction, or the project was inserted by a migration/import
   * that didn't create the row), we insert a fresh row so the project
   * isn't silently skipped. Without this, projectCount=0 and the
   * scheduler does nothing until a manual /api/projects/:id/wake.
   * (Ticket pd-10.)
   */
  start(): void {
    // Repair: ensure every active project has a heartbeat row.
    const now = Date.now();
    const orphans = this.db
      .prepare(
        `SELECT p.id FROM projects p
         LEFT JOIN project_heartbeats ph ON ph.project_id = p.id
         WHERE p.status = 'active' AND ph.project_id IS NULL`,
      )
      .all() as Array<{ id: string }>;

    if (orphans.length > 0) {
      const insert = this.db.prepare(
        `INSERT INTO project_heartbeats (project_id, next_check_at, updated_at)
         VALUES (?, ?, ?)`,
      );
      this.db.transaction(() => {
        for (const { id } of orphans) {
          insert.run(id, now + 5000, now);
          this.logger.warn({ projectId: id }, 'Created missing heartbeat row for active project');
        }
      })();
    }

    // Load all heartbeat rows and schedule timers.
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

    const activeCount = (this.db
      .prepare("SELECT COUNT(*) AS c FROM projects WHERE status = 'active'")
      .get() as { c: number }).c;

    this.logger.info(
      { projectCount: projects.length, activeProjects: activeCount, repairedOrphans: orphans.length },
      'Scheduler started',
    );
  }

  /**
   * Schedule a newly created project. Called by the POST /api/projects
   * route so the project gets a timer immediately — without this, the
   * project sits idle until the next daemon restart or manual wake.
   */
  scheduleNewProject(projectId: string): void {
    const row = this.db
      .prepare('SELECT next_check_at FROM project_heartbeats WHERE project_id = ?')
      .get(projectId) as { next_check_at: number } | undefined;
    if (!row) {
      this.logger.warn({ projectId }, 'No heartbeat row for new project — cannot schedule');
      return;
    }
    this.scheduleNext(projectId, row.next_check_at);
    this.logger.info({ projectId }, 'New project scheduled');
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
        // applyBackoff itself can throw (e.g., DB closed during shutdown),
        // so wrap it with a hard fallback. (Code Review #7 M1)
        try {
          this.applyBackoff(projectId);
        } catch (backoffErr) {
          this.logger.error({ err: backoffErr, projectId }, 'applyBackoff failed — using hard fallback timer');
          // Guarantee a timer exists even when the DB is unavailable.
          const fallbackMs = this.config.heartbeat.base_interval_seconds * 1000;
          const fallbackTimer = setTimeout(() => {
            this.timers.delete(projectId);
            this.handleHeartbeat(projectId).catch(() => { /* next cycle will retry */ });
          }, fallbackMs);
          this.timers.set(projectId, fallbackTimer);
        }
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
    let concurrencyCapHit = false;

    for (const col of agentColumns) {
      // If we already hit the concurrency cap in a previous column, don't
      // bother querying more columns — tickets are deferred to next heartbeat.
      // (Code Review #7 M2)
      if (concurrencyCapHit) break;

      // Find unclaimed tickets that don't already have a running agent.
      // The LEFT JOIN anti-pattern prevents double-spawn when two concurrent
      // handleHeartbeat calls query the same column — if handleHeartbeat #1
      // already created an agent_runs row for a ticket, handleHeartbeat #2
      // won't find it. (Security Review #7 MEDIUM-01)
      const tickets = this.db
        .prepare(
          `SELECT t.id FROM tickets t
           LEFT JOIN agent_runs ar ON ar.ticket_id = t.id AND ar.exit_status = 'running'
           WHERE t.project_id = ? AND t."column" = ? AND t.claimed_by_run_id IS NULL
             AND ar.id IS NULL
           ORDER BY t.created_at`,
        )
        .all(projectId, col.column_id) as Array<{ id: string }>;

      if (tickets.length === 0) continue;
      foundWork = true;

      this.logger.info(
        { projectId, column: col.column_id, agentType: col.agent_type_id, ticketCount: tickets.length },
        'Work found — spawning agents',
      );

      // Spawn agents for each ticket (up to concurrency cap).
      // Distinguish concurrency errors from other errors — a DB error on
      // ticket 1 shouldn't silently defer tickets 2-N. (Code Review #7 M2)
      for (const ticket of tickets) {
        // Circuit breaker: count runs since the ticket last moved columns.
        // If too many runs have happened without progress, the agent is stuck
        // (MCP failure, prompt confusion, model bug — doesn't matter). Move
        // the ticket to human and stop burning tokens. Prevents the overnight
        // 242-run scenario where agents respawned every 5 min accomplishing
        // nothing. The threshold is configurable (default: 3).
        const runsSinceLastMove = (this.db.prepare(
          `SELECT COUNT(*) AS c FROM agent_runs
           WHERE ticket_id = ? AND started_at > COALESCE(
             (SELECT MAX(created_at) FROM ticket_comments WHERE ticket_id = ? AND type = 'move'),
             0
           )`,
        ).get(ticket.id, ticket.id) as { c: number }).c;

        if (runsSinceLastMove >= this.config.agents.circuit_breaker_max_runs) {
          this.logger.warn(
            { ticketId: ticket.id, runs: runsSinceLastMove, threshold: this.config.agents.circuit_breaker_max_runs },
            'Circuit breaker tripped — ticket stuck, moving to human',
          );
          const now = Date.now();
          this.db.transaction(() => {
            this.db.prepare(
              `UPDATE tickets SET "column" = 'human', claimed_by_run_id = NULL, claimed_at = NULL, updated_at = ?
               WHERE id = ?`,
            ).run(now, ticket.id);
            this.db.prepare(
              `INSERT INTO ticket_comments (id, ticket_id, type, author, body, meta, created_at)
               VALUES (?, ?, 'block', 'system:circuit-breaker', ?, ?, ?)`,
            ).run(
              randomUUID(),
              ticket.id,
              `Agent ran ${runsSinceLastMove} times without moving this ticket. Moved to human for review. Check the agent transcripts to understand why progress stalled.`,
              JSON.stringify({ runs_since_move: runsSinceLastMove, threshold: this.config.agents.circuit_breaker_max_runs }),
              now,
            );
          })();
          continue; // Skip spawning, move to next ticket
        }

        try {
          await runAgent(
            { projectId, agentTypeId: col.agent_type_id, ticketId: ticket.id },
            this.db,
            this.config,
            this.logger,
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : '';
          if (msg.includes('Concurrency limit') || msg.includes('concurrency limit')) {
            this.logger.warn({ projectId }, 'Concurrency cap hit — deferring remaining tickets');
            concurrencyCapHit = true;
          } else {
            this.logger.error(
              { err, projectId, ticketId: ticket.id, agentType: col.agent_type_id },
              'runAgent failed — skipping this ticket',
            );
          }
          break;
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

    const result = this.db
      .prepare(
        `UPDATE project_heartbeats
         SET next_check_at = ?, consecutive_empty_checks = ?, updated_at = ?
         WHERE project_id = ?`,
      )
      .run(nextCheck, emptyChecks, now, projectId);

    // If no row was updated, the project has no heartbeat record — the
    // in-memory timer won't survive a restart. (Code Review #7 L1)
    if (result.changes === 0) {
      this.logger.error({ projectId }, 'No project_heartbeats row — schedule will not survive restart');
    }

    this.scheduleNext(projectId, nextCheck);

    this.logger.debug(
      { projectId, emptyChecks, intervalMs, nextCheckIn: `${Math.round(intervalMs / 1000)}s` },
      'Backoff applied',
    );
  }
}
