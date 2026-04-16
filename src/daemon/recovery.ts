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
// Recovery actions:
//   1. Mark orphaned runs as 'crashed'
//   2. Release ticket claims (scoped to the crashed run)
//   3. Move the ticket to the 'human' column so it appears in the inbox
//      (per DESIGN.md §11.7 — "the ticket is moved back to Human")
//   4. Add a block comment explaining what happened
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
  movedToHuman: number;
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
    return { orphanedRuns: 0, releasedTickets: 0, movedToHuman: 0 };
  }

  childLogger.warn(
    { count: orphanedRuns.length, runIds: orphanedRuns.map((r) => r.id) },
    'Orphaned agent runs found — cleaning up',
  );

  const now = Date.now();
  let releasedTickets = 0;
  let movedToHuman = 0;

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

    const getTicketColumn = db.prepare(
      'SELECT "column" FROM tickets WHERE id = ?',
    );

    const moveToHuman = db.prepare(
      `UPDATE tickets SET "column" = 'human', updated_at = ? WHERE id = ?`,
    );

    const addComment = db.prepare(
      `INSERT INTO ticket_comments (id, ticket_id, type, author, body, meta, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );

    // Track which tickets we've already moved + commented on in this
    // recovery pass. When multiple runs crashed for the same ticket
    // (e.g. daemon restarted several times quickly), emit one summary
    // comment per ticket instead of spamming N identical blocks.
    // Overnight this bug produced 5-6 duplicate block comments per ticket.
    const commentedTickets = new Set<string>();

    for (const run of orphanedRuns) {
      // 1. Mark the run as crashed
      updateRun.run(
        now,
        'Daemon crashed or was killed during this run. The agent subprocess was terminated.',
        run.id,
      );

      // 2. Release the ticket claim (scoped to this run's ID)
      const released = releaseTicket.run(now, run.id);
      if (released.changes > 0) {
        releasedTickets += released.changes;
      }

      // 3+4: Move + comment — deduplicated per ticket. If we already
      // handled this ticket for an earlier orphaned run in this pass,
      // skip the move and the block comment. The run is still marked
      // crashed (step 1) so it's tracked in agent_runs history.
      if (commentedTickets.has(run.ticket_id)) continue;
      commentedTickets.add(run.ticket_id);

      // 3. Move ticket to 'human' column if it's not already there.
      const ticketRow = getTicketColumn.get(run.ticket_id) as
        | { column: string }
        | undefined;

      if (ticketRow && ticketRow.column !== 'human') {
        const fromColumn = ticketRow.column;
        moveToHuman.run(now, run.ticket_id);
        movedToHuman++;

        addComment.run(
          randomUUID(),
          run.ticket_id,
          'move',
          'system:recovery',
          `Moved from '${fromColumn}' to 'human' by crash recovery`,
          JSON.stringify({ from_column: fromColumn, to_column: 'human' }),
          now,
        );
      }

      // 4. One block comment per ticket listing all crashed runs.
      const ticketRuns = orphanedRuns.filter((r) => r.ticket_id === run.ticket_id);
      const runSummary = ticketRuns.length === 1
        ? `1 agent run was interrupted`
        : `${ticketRuns.length} agent runs were interrupted`;

      addComment.run(
        randomUUID(),
        run.ticket_id,
        'block',
        'system:recovery',
        `${runSummary} by a daemon crash. The ticket has been moved to your inbox for review.`,
        JSON.stringify({
          recovered_run_ids: ticketRuns.map((r) => r.id),
          agent_types: [...new Set(ticketRuns.map((r) => r.agent_type_id))],
          recovery_at: now,
        }),
        now,
      );
    }
  });

  apply();

  childLogger.info(
    { orphanedRuns: orphanedRuns.length, releasedTickets, movedToHuman },
    'Crash recovery complete',
  );

  return { orphanedRuns: orphanedRuns.length, releasedTickets, movedToHuman };
}
