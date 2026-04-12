import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Database } from 'better-sqlite3';
import {
  getTicketWithComments,
  getTicket,
  moveTicket,
  addComment,
} from '../db/queries/tickets.js';

interface McpContext {
  runId: string;
  ticketId: string;
  projectId: string;
}

/**
 * Register all Project Dispatcher MCP tools on the given server.
 *
 * Every tool enforces scope: it can only operate on tickets belonging
 * to the project the agent was spawned for (ctx.projectId). The ticket
 * the agent was assigned is ctx.ticketId — some tools (read_my_ticket,
 * claim_ticket, add_comment, move_to_column) operate on it implicitly.
 *
 * Tool list follows DESIGN.md §16 and the Principle of Least Privilege:
 * no generic execute_sql, no generic file tools, only specific ticket
 * operations.
 */
export function registerTools(server: McpServer, db: Database, ctx: McpContext): void {
  const authorString = `agent:${process.env['DISPATCH_AGENT_TYPE'] ?? 'unknown'}:${ctx.runId}`;

  // --- read_my_ticket ---
  server.registerTool('read_my_ticket', {
    description: 'Read the ticket assigned to this agent run, including the full comment thread.',
  }, async () => {
    const ticket = getTicketWithComments(db, ctx.ticketId);
    if (!ticket) {
      return { content: [{ type: 'text', text: `Error: ticket ${ctx.ticketId} not found` }], isError: true };
    }
    return { content: [{ type: 'text', text: JSON.stringify(ticket, null, 2) }] };
  });

  // --- read_ticket ---
  server.registerTool('read_ticket', {
    description: 'Read any ticket in the same project (for cross-reference). Fails if the ticket belongs to a different project.',
    inputSchema: { ticket_id: z.string().uuid() },
  }, async (args) => {
    const ticket = getTicketWithComments(db, args.ticket_id);
    if (!ticket) {
      return { content: [{ type: 'text', text: `Error: ticket ${args.ticket_id} not found` }], isError: true };
    }
    if (ticket.project_id !== ctx.projectId) {
      return {
        content: [{ type: 'text', text: `Error: ticket ${args.ticket_id} belongs to a different project` }],
        isError: true,
      };
    }
    return { content: [{ type: 'text', text: JSON.stringify(ticket, null, 2) }] };
  });

  // --- claim_ticket ---
  server.registerTool('claim_ticket', {
    description: 'Claim the assigned ticket for this agent run. Must be called before making changes. Fails if already claimed by another run.',
  }, async () => {
    const ticket = getTicket(db, ctx.ticketId);
    if (!ticket) {
      return { content: [{ type: 'text', text: `Error: ticket ${ctx.ticketId} not found` }], isError: true };
    }
    if (ticket.claimed_by_run_id && ticket.claimed_by_run_id !== ctx.runId) {
      return {
        content: [{ type: 'text', text: `Error: ticket already claimed by run ${ticket.claimed_by_run_id}` }],
        isError: true,
      };
    }

    const now = Date.now();
    db.prepare(
      'UPDATE tickets SET claimed_by_run_id = ?, claimed_at = ?, updated_at = ? WHERE id = ?',
    ).run(ctx.runId, now, now, ctx.ticketId);

    return { content: [{ type: 'text', text: 'Ticket claimed successfully.' }] };
  });

  // --- add_comment ---
  server.registerTool('add_comment', {
    description: 'Add a comment to the assigned ticket. Comments are append-only.',
    inputSchema: {
      type: z.string().describe('Comment type: comment, journal, block, finding, complete'),
      body: z.string().describe('Comment body text'),
      meta: z.string().optional().describe('Optional JSON metadata'),
    },
  }, async (args) => {
    let meta: Record<string, unknown> | undefined;
    if (args.meta) {
      try {
        meta = JSON.parse(args.meta) as Record<string, unknown>;
      } catch {
        return { content: [{ type: 'text', text: 'Error: meta must be valid JSON' }], isError: true };
      }
    }

    const comment = addComment(db, ctx.ticketId, {
      type: args.type,
      author: authorString,
      body: args.body,
      meta,
    });

    return { content: [{ type: 'text', text: `Comment added (id: ${comment.id})` }] };
  });

  // --- attach_finding ---
  server.registerTool('attach_finding', {
    description: 'Attach a review finding to the assigned ticket. Shorthand for add_comment with type=finding.',
    inputSchema: {
      severity: z.enum(['critical', 'high', 'medium', 'low']).describe('Finding severity'),
      title: z.string().describe('Short title of the finding'),
      body: z.string().describe('Detailed description with file:line references and recommended action'),
    },
  }, async (args) => {
    const comment = addComment(db, ctx.ticketId, {
      type: 'finding',
      author: authorString,
      body: `**[${args.severity.toUpperCase()}]** ${args.title}\n\n${args.body}`,
      meta: { severity: args.severity, title: args.title },
    });

    return { content: [{ type: 'text', text: `Finding attached (id: ${comment.id}, severity: ${args.severity})` }] };
  });

  // --- move_to_column ---
  server.registerTool('move_to_column', {
    description: 'Move the assigned ticket to a different column and release the claim. Optionally add a completion comment.',
    inputSchema: {
      column_id: z.string().describe('Target column slug'),
      comment: z.string().optional().describe('Optional completion comment'),
    },
  }, async (args) => {
    // Add a completion comment first if provided
    if (args.comment) {
      addComment(db, ctx.ticketId, {
        type: 'complete',
        author: authorString,
        body: args.comment,
      });
    }

    // Move the ticket
    const moved = moveTicket(db, ctx.ticketId, {
      toColumn: args.column_id,
      comment: `Moved by ${authorString}`,
      author: authorString,
    });

    if (!moved) {
      return { content: [{ type: 'text', text: 'Error: failed to move ticket' }], isError: true };
    }

    // Release the claim
    db.prepare(
      'UPDATE tickets SET claimed_by_run_id = NULL, claimed_at = NULL, updated_at = ? WHERE id = ?',
    ).run(Date.now(), ctx.ticketId);

    return { content: [{ type: 'text', text: `Ticket moved to column '${args.column_id}'` }] };
  });

  // --- release_ticket ---
  server.registerTool('release_ticket', {
    description: 'Release the claim on the assigned ticket without moving it. Use when the agent cannot proceed but does not want to block.',
  }, async () => {
    db.prepare(
      'UPDATE tickets SET claimed_by_run_id = NULL, claimed_at = NULL, updated_at = ? WHERE id = ?',
    ).run(Date.now(), ctx.ticketId);

    return { content: [{ type: 'text', text: 'Ticket claim released.' }] };
  });
}
