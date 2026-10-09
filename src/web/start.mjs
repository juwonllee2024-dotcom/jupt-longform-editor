import path from 'node:path';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createVideoEditorServer } from './server.mjs';

function parsePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error('PORT must be an integer between 0 and 65535');
  }
  return port;
}

export function defaultWebServerConfig(env = process.env) {
  const host = String(env.HOST || '127.0.0.1').trim() || '127.0.0.1';
  const port = parsePort(env.PORT === undefined ? 12_345 : env.PORT);
  return { host, port };
}

export async function startWebServer(env = process.env, options = {}) {
  const config = defaultWebServerConfig(env);
  return createVideoEditorServer({
    ...options,
    host: options.host || config.host,
    port: options.port === undefined ? config.port : options.port,
  });
}

export async function runWebServerProcess(env = process.env) {
  const app = await startWebServer(env);
  const address = app.address;
  const shownHost = address.address.includes(':') ? `[${address.address}]` : address.address;
  console.log(`Local video editor: http://${shownHost}:${address.port}/`);
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    await app.close();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  return app;
}

export function isMainModule(argvPath = process.argv[1], moduleUrl = import.meta.url) {
  if (!argvPath || !moduleUrl) return false;
  try {
    const canonicalPath = (value) => {
      const absolute = path.resolve(value);
      try {
        return path.normalize(realpathSync(absolute)).toLowerCase();
      } catch {
        return path.normalize(absolute).toLowerCase();
      }
    };
    const entryPath = canonicalPath(argvPath);
    const currentPath = canonicalPath(fileURLToPath(moduleUrl));
    return entryPath === currentPath;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  runWebServerProcess().catch((error) => {
    console.error(`Local video editor failed: ${error?.message || 'server error'}`);
    process.exitCode = 1;
  });
}
