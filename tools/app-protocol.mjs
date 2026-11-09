import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// The editor owns the protocol. Publishers use a pinned checkout as a build tool;
// the application never needs a catalog, mapping or sample checkout to run.
export async function loadAppProtocol(appRoot) {
  const root = resolve(appRoot);
  const require = createRequire(resolve(root, 'package.json'));
  const { createServer } = await import(pathToFileURL(require.resolve('vite')).href);
  const server = await createServer({ root, configFile: false, server: { middlewareMode: true }, appType: 'custom' });
  try {
    const modules = {};
    for (const name of ['resourceGraph', 'resourcePackage', 'remoteLibrary', 'soundResources', 'sharedAudio', 'instruments', 'sampleReference', 'model', 'aiAuthoring', 'prepareSamples', 'engine']) {
      Object.assign(modules, await server.ssrLoadModule(`/src/${name}.ts`));
    }
    return { ...modules, close: () => server.close() };
  } catch (error) {
    await server.close();
    throw error;
  }
}
