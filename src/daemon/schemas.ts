// Shared Zod schemas for HTTP route validation.
// One file for now — split into per-route files if this grows past ~200 lines.

import { z } from 'zod';

// --- Projects ---

export const createProjectBody = z.object({
  name: z.string().min(1).max(200),
  path: z.string().min(1),
  // Template to clone on registration. Accepts a library project_type id
  // (e.g. 'software-dev') or the literal 'blank' for an empty workflow.
  project_type_id: z.string().min(1),
});

/**
 * Body for PUT /api/projects/:id/workflow — full replacement of the project's
 * column list. Scope-safe because the route first resolves the project, then
 * loads the project-scoped project_type, then updates only its columns.
 *
 * Zod-level guarantees (defence-in-depth ahead of DB checks):
 * - `column_id` matches a safe slug and is length-bounded.
 * - `agent_type_id`, if set, is a valid UUID — agent rows use UUIDs (forks)
 *   or library slugs that pass the UUID-or-slug permissive pattern; we
 *   allow either form via a tighter custom check rather than .uuid() so
 *   built-in slugs like "coding-agent" still work.
 * - `column_id` values are unique within the request.
 * - `order` values are unique within the request.
 */
export const updateProjectWorkflowBody = z.object({
  columns: z.array(z.object({
    column_id: z.string().min(1).max(50).regex(/^[a-z0-9-]+$/),
    name: z.string().min(1).max(100),
    // Library agents are seeded with slug ids (e.g. "coding-agent"); forks
    // use UUIDs. Accept both forms via a conservative character set; the
    // route does the authoritative scope check against the DB. Length-bounded
    // to keep rejection cheap for obvious junk.
    agent_type_id: z.string().min(1).max(100).regex(/^[a-z0-9-]+$/).nullable().optional(),
    order: z.number().int().min(0),
  })).min(1).refine(
    (cols) => new Set(cols.map((c) => c.column_id)).size === cols.length,
    { message: 'column_id values must be unique within a workflow' },
  ).refine(
    (cols) => new Set(cols.map((c) => c.order)).size === cols.length,
    { message: 'order values must be unique within a workflow' },
  ),
});

export const updateProjectBody = z.object({
  name: z.string().min(1).max(200).optional(),
  project_type_id: z.string().min(1).optional(),
  status: z.enum(['active', 'dormant', 'missing', 'archived']).optional(),
});

export const listProjectsQuery = z.object({
  status: z.enum(['active', 'dormant', 'missing', 'archived']).optional(),
});

export const idParam = z.object({
  id: z.string().uuid(),
});
