import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { FastifyInstance } from 'fastify';

export async function setupWizardRoutes(app: FastifyInstance): Promise<void> {
  app.get('/ui/setup', async (_request, reply) => {
    const claudeDir = join(homedir(), '.claude');
    const credentialsPath = join(claudeDir, 'credentials.json');
    const oauthDetected = existsSync(credentialsPath);

    return reply.view('setup-wizard.hbs', {
      activePage: 'settings',
      pageTitle: 'Setup',
      breadcrumbs: [{ label: 'Setup', href: '/ui/setup' }],
      oauthDetected,
    });
  });
}
