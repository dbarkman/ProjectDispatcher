// Crash recovery for Project Dispatcher.
//
// When the daemon starts, there may be stale state from a previous crash
// or kill. This module cleans it up before the scheduler starts.
//
// Stale state looks like:
//   - agent_runs rows with exit_status = 'running' (the subprocess was
//     killed when the daemon died)
//   - tickets with claimed_by_run_id pointing at one of those dead runs
//
// Recovery: mark runs as 'crashed', release ticket claims, add a block
// comment so the human sees the ticket in their inbox.
//
// This MUST run before the scheduler starts — otherwise the scheduler
// might try to spawn an agent for a ticket that's still "claimed" by
// a dead run, and the claim check would reject the new run.

import type { Database } from 'better-sqlite3';
import type { Logger } from 'pino';
import { randomUUID } from 'node:crypto';

export interface RecoveryResult {
  orphanedRuns: number;
  releasedTickets: number;
}

/**
 * Clean up stale state from a previous daemon crash.
 *
 * Runs inside a single transaction so partial recovery doesn't leave
 * inconsistent state. Either all orphaned runs are cleaned up or none.
 */
export function recoverFromCrash(db: Database, logger: Logger): RecoveryResult {
  const childLogger = logger.child({ component: 'recovery' });

  // Find all runs that were still 'running' when the daemon died
  const orphanedRuns = db
    .prepare("SELECT id, ticket_id, agent_type_id FROM agent_runs WHERE exit_status = 'running'")
    .all() as Array<{ id: string; ticket_id: string; agent_type_id: string }>;

  if (orphanedRuns.length === 0) {
    childLogger.debug('No orphaned runs found — clean startup');
    return { orphanedRuns: 0, releasedTickets: 0 };
  }

  childLogger.warn(
    { count: orphanedRuns.length, runIds: orphanedRuns.map((r) => r.id) },
    'Orphaned agent runs found — cleaning up',
  );

  const now = Date.now();
  let releasedTickets = 0;

  const apply = db.transaction(() => {
    const updateRun = db.prepare(
      `UPDATE agent_runs
       SET exit_status = 'crashed', ended_at = ?, error_message = ?
       WHERE id = ?`,
    );

    const releaseTicket = db.prepare(
      `UPDATE tickets
       SET claimed_by_run_id = NULL, claimed_at = NULL, updated_at = ?
       WHERE claimed_by_run_id = ?`,
    );

    const addBlockComment = db.prepare(
      `INSERT INTO ticket_comments (id, ticket_id, type, author, body, meta, created_at)
       VALUES (?, ?, 'block', ?, ?, ?, ?)`,
    );

    for (const run of orphanedRuns) {
      // Mark the run as crashed
      updateRun.run(
        now,
        'Daemon crashed or was killed during this run. The agent subprocess was terminated.',
        run.id,
      );

      // Release the ticket claim
      const released = releaseTicket.run(now, run.id);
      if (released.changes > 0) {
        releasedTickets += released.changes;

        // Add a block comment so the human sees it in the inbox
        addBlockComment.run(
          randomUUID(),
          run.ticket_id,
          'block',
          `system:recovery`,
          `Agent run ${run.id} (${run.agent_type_id}) was interrupted by a daemon crash. The ticket claim has been released. Please review and reassign.`,
          JSON.stringify({
            recovered_run_id: run.id,
            agent_type: run.agent_type_id,
            recovery_at: now,
          }),
          now,
        );
      }
    }
  });

  apply();

  childLogger.info(
    { orphanedRuns: orphanedRuns.length, releasedTickets },
    'Crash recovery complete',
  );

  return { orphanedRuns: orphanedRuns.length, releasedTickets };
}
