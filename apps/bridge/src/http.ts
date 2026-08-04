/**
 * The bridge's HTTP surface.
 *
 * A deliberately small set of loopback endpoints under `/bridge/*`, plus optional
 * static hosting of the built interface. Written directly against `node:http` — no
 * Express, no framework — because the whole surface is six routes and a dependency
 * would buy nothing.
 *
 * This HTTP server exists solely so a browser can reach the process that owns the TCP
 * socket. It carries commands *about* SLTP; it never carries SLTP framing.
 */
import type http from 'node:http';
import path from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import { SltpClientError } from '@socketlens/core';
import type { EventHub } from './events.js';
import type { Relay, RelayRequest } from './relay.js';

/** What the HTTP surface needs. */
export interface HttpSurfaceOptions {
  readonly relay: Relay;
  readonly hub: EventHub;
  /** Directory of built assets to serve, when the interface is prebuilt. */
  readonly staticDir: string | undefined;
}

/** Largest command body the bridge will read, guarding against an unbounded upload. */
const MAX_BODY_BYTES = 1_048_576;

/** Extensions the static handler knows how to label. */
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.map': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/** Builds the HTTP request handler. */
export function createRequestHandler(
  options: HttpSurfaceOptions,
): (request: http.IncomingMessage, response: http.ServerResponse) => void {
  const { relay, hub, staticDir } = options;

  return (request, response) => {
    handle(request, response).catch((cause: unknown) => {
      // A handler must never take the process down; the interface gets a 500 instead.
      sendJson(response, 500, {
        error: cause instanceof Error ? cause.message : String(cause),
      });
    });
  };

  async function handle(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> {
    // Only the loopback interface is bound, but a browser on this machine can still be
    // pointed here by a hostile page. Rejecting unexpected Origins keeps a website from
    // driving the user's TCP socket through their own browser.
    if (!originIsAcceptable(request)) {
      sendJson(response, 403, {
        error: 'Cross-origin requests to the bridge are refused.',
      });
      return;
    }

    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const route = url.pathname;

    if (route === '/bridge/events') {
      if (request.method !== 'GET') return sendJson(response, 405, { error: 'Use GET.' });
      hub.subscribe(response);
      return;
    }

    if (route === '/bridge/status') {
      if (request.method !== 'GET') return sendJson(response, 405, { error: 'Use GET.' });
      return sendJson(response, 200, relay.status);
    }

    if (route === '/bridge/connect') {
      if (request.method !== 'POST') return sendJson(response, 405, { error: 'Use POST.' });
      try {
        return sendJson(response, 200, await relay.connect());
      } catch (cause) {
        return sendJson(response, 502, { error: describe(cause), status: relay.status });
      }
    }

    if (route === '/bridge/disconnect') {
      if (request.method !== 'POST') return sendJson(response, 405, { error: 'Use POST.' });
      return sendJson(response, 200, await relay.disconnect());
    }

    if (route === '/bridge/request') {
      if (request.method !== 'POST') return sendJson(response, 405, { error: 'Use POST.' });
      const body = await readJsonBody(request, response);
      if (body === undefined) return;

      const command = body as Partial<RelayRequest>;
      if (typeof command.operation !== 'string' || command.operation.length === 0) {
        return sendJson(response, 400, { error: 'A request needs an "operation".' });
      }

      try {
        return sendJson(response, 200, await relay.send(command as RelayRequest));
      } catch (cause) {
        // A timeout or a dropped connection is a reportable condition, not a bridge
        // fault: the interface renders it in the timeline like any other outcome.
        const code = cause instanceof SltpClientError ? cause.code : 'error';
        return sendJson(response, 502, { error: describe(cause), code });
      }
    }

    if (route === '/bridge/raw') {
      if (request.method !== 'POST') return sendJson(response, 405, { error: 'Use POST.' });
      const body = await readJsonBody(request, response);
      if (body === undefined) return;

      const { bytes } = body as { bytes?: unknown };
      if (typeof bytes !== 'string') {
        return sendJson(response, 400, { error: 'Raw sends need a "bytes" string.' });
      }

      try {
        return sendJson(response, 200, await relay.sendRaw(bytes));
      } catch (cause) {
        return sendJson(response, 502, { error: describe(cause) });
      }
    }

    if (route.startsWith('/bridge/')) {
      return sendJson(response, 404, { error: `No bridge route ${route}.` });
    }

    if (staticDir !== undefined) {
      return serveStatic(staticDir, route, response);
    }

    sendJson(response, 404, {
      error:
        'The bridge is running without a built interface. Start the Vite dev server ' +
        'with `npm run dev:gui`, or pass --static <dir> to serve a production build.',
    });
  }
}

/**
 * Rejects requests from an unexpected origin.
 *
 * Same-origin browser requests to the bridge carry no `Origin`, or carry the bridge's
 * own. The Vite dev server proxies `/bridge/*`, so those arrive origin-less too. A page
 * on any other site would carry its own origin, and is refused.
 */
function originIsAcceptable(request: http.IncomingMessage): boolean {
  const origin = request.headers.origin;
  if (origin === undefined) return true;
  try {
    const { hostname } = new URL(origin);
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1';
  } catch {
    return false;
  }
}

/** Reads and parses a JSON request body, answering the client on failure. */
async function readJsonBody(
  request: http.IncomingMessage,
  response: http.ServerResponse,
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    total += buffer.length;
    if (total > MAX_BODY_BYTES) {
      sendJson(response, 413, { error: 'The command body is too large.' });
      request.destroy();
      return undefined;
    }
    chunks.push(buffer);
  }

  const text = Buffer.concat(chunks).toString('utf8');
  if (text.trim().length === 0) return {};

  try {
    return JSON.parse(text);
  } catch (cause) {
    sendJson(response, 400, { error: `The command body is not valid JSON: ${describe(cause)}` });
    return undefined;
  }
}

/** Serves one file from the built interface, falling back to index.html for routes. */
async function serveStatic(
  staticDir: string,
  route: string,
  response: http.ServerResponse,
): Promise<void> {
  const relative = route === '/' ? 'index.html' : route.replace(/^\/+/, '');
  const resolved = path.resolve(staticDir, relative);

  // A crafted path must not escape the asset directory.
  if (resolved !== staticDir && !resolved.startsWith(staticDir + path.sep)) {
    sendJson(response, 403, { error: 'Refused.' });
    return;
  }

  try {
    const info = await stat(resolved);
    if (info.isDirectory()) throw new Error('directory');
    const file = await readFile(resolved);
    response.writeHead(200, {
      'Content-Type':
        CONTENT_TYPES[path.extname(resolved).toLowerCase()] ?? 'application/octet-stream',
      'Content-Length': file.length,
    });
    response.end(file);
  } catch {
    // Unknown paths fall back to the entry document so client-side routing works.
    try {
      const fallback = await readFile(path.join(staticDir, 'index.html'));
      response.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': fallback.length,
      });
      response.end(fallback);
    } catch {
      sendJson(response, 404, { error: `Not found: ${route}` });
    }
  }
}

/** Writes a JSON response. */
function sendJson(response: http.ServerResponse, status: number, payload: unknown): void {
  if (response.headersSent) return;
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
  });
  response.end(body);
}

/** Renders an unknown thrown value as a message. */
function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
