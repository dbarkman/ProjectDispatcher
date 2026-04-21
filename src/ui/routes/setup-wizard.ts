import type { FastifyInstance } from 'fastify';

export async function setupWizardRoutes(app: FastifyInstance): Promise<void> {
  app.get('/ui/setup', async (_request, reply) => {
    return reply.view('setup-wizard.hbs', {
      activePage: 'settings',
      pageTitle: 'Setup',
      breadcrumbs: [{ label: 'Setup', href: '/ui/setup' }],
    });
  });
}
