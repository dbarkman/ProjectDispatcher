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
 */
export const updateProjectWorkflowBody = z.object({
  columns: z.array(z.object({
    column_id: z.string().min(1).max(50).regex(/^[a-z0-9-]+$/),
    name: z.string().min(1).max(100),
    agent_type_id: z.string().nullable().optional(),
    order: z.number().int().min(0),
  })).min(1),
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
