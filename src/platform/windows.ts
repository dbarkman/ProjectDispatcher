// Windows platform integration — stub implementation.
//
// Full implementation requires the `node-windows` package for service
// management via sc.exe. For MVP, the daemon runs manually via
// `npm run dev` or `node dist/daemon/index.js`. Service installation
// is deferred to post-MVP.
//
// When implemented: install as a Windows Service named "ProjectDispatcher"
// with stdout/stderr routed to %USERPROFILE%\Development\.tasks\logs\.
// May require Administrator privileges for sc.exe operations.

interface ServiceConfig {
  daemonEntryPath: string;
  nodePath: string;
  logsDir: string;
  workingDir: string;
}

export async function installService(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _config: ServiceConfig,
): Promise<void> {
  throw new Error(
    'Windows service installation is not yet implemented. ' +
    'Run the daemon manually with: node dist/daemon/index.js',
  );
}

export async function uninstallService(): Promise<void> {
  throw new Error('Windows service uninstallation is not yet implemented.');
}

export async function startService(): Promise<void> {
  throw new Error('Windows service management is not yet implemented.');
}

export async function stopService(): Promise<void> {
  throw new Error('Windows service management is not yet implemented.');
}

export async function getServiceStatus(): Promise<'running' | 'stopped' | 'not-installed'> {
  return 'not-installed';
}
