#!/usr/bin/env node
/**
 * Deterministic SLTP traffic generator for packet capture.
 *
 * Wireshark (or `tshark`) can show what a protocol really looks like on the wire, but
 * only if there is traffic to look at and only if you can tell which TCP stream is
 * which. This script produces a small, labelled, repeatable set of exchanges against a
 * running SocketLens TCP server, printing for each one the local port, the Request-ID,
 * the byte count, and how many `socket.write()` calls were used — everything needed to
 * find the exchange in a capture and check it against what the application intended.
 *
 * Packet-capture software is NOT required to run this, and is not a dependency of the
 * project. Without Wireshark open, this is simply a traffic generator.
 *
 *   npm run wireshark:demo                          # every scenario once
 *   npm run wireshark:demo -- --list
 *   npm run wireshark:demo -- --scenario fragmentation
 *   npm run wireshark:demo -- --loop --interval 2000
 *   npm run wireshark:demo -- --port 7420 --host 127.0.0.1
 *
 * See docs/wireshark-capture.md for the capture procedure on Windows.
 */
import net from 'node:net';
import {
  DEFAULT_CONTROL_PORT,
  DEFAULT_HOST,
  SLTP_HEADER,
  SltpDecoder,
  encodeRequest,
} from '@socketlens/protocol';

// ─── output helpers ──────────────────────────────────────────────────────────

const BAR = '─'.repeat(76);
const LABEL_WIDTH = 16;
const WRAP_AT = 76;
let counter = 0;

/**
 * Prints one `label  value` line, wrapping long values under a hanging indent.
 *
 * Long unwrapped lines are unreadable on a projector, and these scenarios are meant to
 * be read aloud from a screen during a demonstration.
 */
function field(label, value) {
  const text = String(value);
  const indent = ' '.repeat(LABEL_WIDTH + 2);
  const room = WRAP_AT - indent.length;
  const lines = [];
  let current = '';

  for (const word of text.split(' ')) {
    if (current === '') {
      current = word;
    } else if (`${current} ${word}`.length <= room) {
      current += ` ${word}`;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current !== '') lines.push(current);

  console.log(`  ${label.padEnd(LABEL_WIDTH)}${lines[0] ?? ''}`);
  for (const line of lines.slice(1)) console.log(`${indent}${line}`);
}

/** Prints a labelled scenario header with everything needed to find it in a capture. */
function announce(name, fields) {
  counter += 1;
  console.log('');
  console.log(`[${counter}] ${name}`);
  console.log(BAR);
  for (const [label, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    field(label, value);
  }
}

/** Prints an indented result line under the current scenario. */
function result(label, value) {
  field(label, value);
}

function now() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── connection helper ───────────────────────────────────────────────────────

/**
 * Opens one TCP connection and returns a small handle over it.
 *
 * Every scenario gets its own connection, so every scenario is its own TCP stream in a
 * capture. That is what makes `tcp.stream eq N` a useful filter here.
 */
function open(host, port) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    // Nagle's algorithm would merge the deliberately separated writes of the
    // fragmentation scenario back into one segment, hiding the thing being shown.
    socket.setNoDelay(true);

    const onError = (cause) => {
      socket.destroy();
      if (cause.code === 'ECONNREFUSED') {
        reject(
          new Error(
            `No SLTP server is listening on ${host}:${port}.\n` +
              '  Start one in another terminal with:  npm run start:server',
          ),
        );
        return;
      }
      reject(cause);
    };

    socket.once('error', onError);
    socket.once('connect', () => {
      socket.removeListener('error', onError);
      socket.on('error', () => {});

      const decoder = new SltpDecoder({ expect: 'response' });
      const responses = [];
      let reads = 0;
      let onMessage = () => {};

      socket.on('data', (chunk) => {
        reads += 1;
        for (const event of decoder.push(chunk)) {
          if (event.type === 'error') {
            responses.push({ error: event.error.message, reason: event.error.reason });
          } else {
            responses.push({
              statusCode: event.message.statusCode,
              statusPhrase: event.message.statusPhrase,
              requestId: event.message.headers.find(
                (f) => f.name.toLowerCase() === SLTP_HEADER.requestId.toLowerCase(),
              )?.value,
              bytes: event.totalBytes,
              body: event.message.body,
            });
          }
          onMessage();
        }
      });

      resolve({
        socket,
        local: `${socket.localAddress}:${socket.localPort}`,
        localPort: socket.localPort,
        responses,
        /** Number of `data` events observed. Not a TCP segment count. */
        reads: () => reads,
        /** Writes one buffer as exactly one `socket.write()` call. */
        write: (buffer) =>
          new Promise((done) => {
            socket.write(buffer, () => done());
          }),
        /** Waits until `count` messages have been framed, or the timeout expires. */
        waitFor: (count, timeoutMs = 4000) =>
          new Promise((done) => {
            if (responses.length >= count) {
              done(true);
              return;
            }
            const timer = setTimeout(() => {
              onMessage = () => {};
              done(false);
            }, timeoutMs);
            onMessage = () => {
              if (responses.length >= count) {
                clearTimeout(timer);
                onMessage = () => {};
                done(true);
              }
            };
          }),
        close: () =>
          new Promise((done) => {
            socket.once('close', () => done());
            socket.end();
          }),
      });
    });
  });
}

/** Splits a buffer at the given sizes, returning the pieces. */
function split(buffer, sizes) {
  const parts = [];
  let offset = 0;
  for (const size of sizes) {
    if (offset >= buffer.length) break;
    parts.push(buffer.subarray(offset, Math.min(offset + size, buffer.length)));
    offset += size;
  }
  if (offset < buffer.length) parts.push(buffer.subarray(offset));
  return parts;
}

/** Renders a response entry for the terminal. */
function describe(entry) {
  if (entry === undefined) return 'nothing received';
  if (entry.error !== undefined) return `framing error (${entry.reason}): ${entry.error}`;
  return `${entry.statusCode} ${entry.statusPhrase}, ${entry.bytes} bytes`;
}

// ─── scenarios ───────────────────────────────────────────────────────────────

/**
 * Each scenario returns after its exchange is complete and its connection is closed.
 *
 * `context` carries the target host and port plus a per-invocation tag, so Request-IDs
 * stay unique across repeated loop iterations and remain greppable in a capture.
 */

async function scenarioPing(context) {
  const requestId = `${context.tag}-ping`;
  const request = encodeRequest({
    operation: 'PING',
    headers: { [SLTP_HEADER.requestId]: requestId },
  });
  const connection = await open(context.host, context.port);

  announce('ping — one request, one response', {
    time: now(),
    target: `${context.host}:${context.port}  (control server)`,
    local: connection.local,
    'Request-ID': requestId,
    request: `${request.length} bytes in 1 application write`,
    expect: '200 OK',
  });

  await connection.write(request);
  await connection.waitFor(1);
  result('response', describe(connection.responses[0]));
  result('reads', `${connection.reads()} data event(s) observed`);
  result('filter', `tcp.port == ${connection.localPort}`);
  await connection.close();
}

async function scenarioUtf8(context) {
  const requestId = `${context.tag}-utf8`;
  const text = 'สวัสดีชาวโลก';
  const body = JSON.stringify({ echo: text });
  const request = encodeRequest({
    operation: 'PING',
    headers: { [SLTP_HEADER.requestId]: requestId },
    body,
    json: true,
  });
  const connection = await open(context.host, context.port);

  announce('utf8 — Content-Length counts bytes, not characters', {
    time: now(),
    target: `${context.host}:${context.port}  (control server)`,
    local: connection.local,
    'Request-ID': requestId,
    body: `"${text}" — ${text.length} characters, ${Buffer.byteLength(text, 'utf8')} bytes`,
    'Content-Length': `${Buffer.byteLength(body, 'utf8')} (the whole JSON body, in bytes)`,
    request: `${request.length} bytes in 1 application write`,
    expect: '200 OK with the echo value returned unchanged',
  });

  await connection.write(request);
  await connection.waitFor(1);
  result('response', describe(connection.responses[0]));
  result('filter', `tcp.port == ${connection.localPort}`);
  await connection.close();
}

async function scenarioFragmentation(context) {
  const requestId = `${context.tag}-frag`;
  const request = encodeRequest({
    operation: 'PING',
    headers: { [SLTP_HEADER.requestId]: requestId },
    body: JSON.stringify({ echo: 'split across writes' }),
    json: true,
  });

  // Cuts chosen to land inside structural markers: mid start line, between a CR and
  // its LF, and one byte short of the end of the \r\n\r\n header delimiter.
  const sizes = [6, 14, 18, 24, 40];
  const parts = split(request, sizes);
  const delayMs = 30;
  const connection = await open(context.host, context.port);

  announce('fragmentation — one message, many writes', {
    time: now(),
    target: `${context.host}:${context.port}  (control server)`,
    local: connection.local,
    'Request-ID': requestId,
    request: `${request.length} bytes in ${parts.length} application writes`,
    'write sizes': parts.map((part) => part.length).join(' + '),
    delay: `${delayMs} ms between writes, so the OS does not merge them`,
    expect:
      'exactly ONE 200 OK — the peer reassembles the message from the stream. ' +
      'Wireshark will show the segments the OS actually produced, which need not ' +
      `equal ${parts.length}.`,
  });

  for (const [index, part] of parts.entries()) {
    if (index > 0) await sleep(delayMs);
    await connection.write(part);
  }
  await connection.waitFor(1);
  result('response', describe(connection.responses[0]));
  result('framed', `${connection.responses.length} complete SLTP message(s)`);
  result('filter', `tcp.port == ${connection.localPort}`);
  await connection.close();
}

async function scenarioCoalescing(context) {
  const first = encodeRequest({
    operation: 'PING',
    headers: { [SLTP_HEADER.requestId]: `${context.tag}-coal-a` },
    body: JSON.stringify({ echo: 'first' }),
    json: true,
  });
  const second = encodeRequest({
    operation: 'PING',
    headers: { [SLTP_HEADER.requestId]: `${context.tag}-coal-b` },
    body: JSON.stringify({ echo: 'second' }),
    json: true,
  });
  const combined = Buffer.concat([first, second]);
  const connection = await open(context.host, context.port);

  announce('coalescing — two messages, one write', {
    time: now(),
    target: `${context.host}:${context.port}  (control server)`,
    local: connection.local,
    'Request-IDs': `${context.tag}-coal-a, ${context.tag}-coal-b`,
    request: `${combined.length} bytes (${first.length} + ${second.length}) in 1 application write`,
    expect:
      'TWO 200 OK responses. Nothing in the byte stream marks where the first ' +
      'message ends — only its Content-Length does.',
  });

  await connection.write(combined);
  await connection.waitFor(2);
  result('responses', `${connection.responses.length} framed`);
  for (const entry of connection.responses) {
    result('', `${describe(entry)}  Request-ID=${entry.requestId ?? '—'}`);
  }
  result('filter', `tcp.port == ${connection.localPort}`);
  await connection.close();
}

async function scenarioDelay(context) {
  // A delayed reply needs a mock rule, which needs a session. This is also the one
  // scenario that produces traffic to a session's own mock endpoint, so a capture
  // shows the control connection and the mock connection as two separate streams.
  const control = await open(context.host, context.port);
  const createId = `${context.tag}-session`;
  await control.write(
    encodeRequest({
      operation: 'CREATE_SESSION',
      headers: { [SLTP_HEADER.requestId]: createId },
      body: JSON.stringify({ name: 'wireshark-demo' }),
      json: true,
    }),
  );
  const created = await control.waitFor(1);
  const payload = created ? JSON.parse(control.responses[0].body) : undefined;
  const session = payload?.session;

  if (session === undefined || session.mockPort === undefined) {
    announce('delay — could not create a session', {
      time: now(),
      target: `${context.host}:${context.port}  (control server)`,
      local: control.local,
      expect: 'skipped: CREATE_SESSION did not return a mock endpoint',
    });
    result('response', describe(control.responses[0]));
    await control.close();
    return;
  }

  const sessionId = session.id;
  const delayMs = 750;
  await control.write(
    encodeRequest({
      operation: 'ADD_RULE',
      headers: {
        [SLTP_HEADER.requestId]: `${context.tag}-rule`,
        [SLTP_HEADER.sessionId]: sessionId,
      },
      body: JSON.stringify({
        name: 'slow-pong',
        match: { operation: 'SLOW' },
        response: { statusCode: 200, statusPhrase: 'OK', delayMs, body: '{"reply":"eventually"}' },
      }),
      json: true,
    }),
  );
  await control.waitFor(2);

  const mockHost = session.mockHost;
  const mockPort = session.mockPort;
  const requestId = `${context.tag}-slow`;
  const request = encodeRequest({
    operation: 'SLOW',
    headers: { [SLTP_HEADER.requestId]: requestId },
  });
  const mock = await open(mockHost, mockPort);

  announce('delay — a deliberately slow response', {
    time: now(),
    target: `${mockHost}:${mockPort}  (session mock endpoint, NOT the control port)`,
    local: mock.local,
    'Session-ID': sessionId,
    'Request-ID': requestId,
    request: `${request.length} bytes in 1 application write`,
    delay: `${delayMs} ms held by the mock rule before it answers`,
    expect: `200 OK arriving about ${delayMs} ms after the request, visible as a gap in the capture timestamps`,
  });

  const startedAt = process.hrtime.bigint();
  await mock.write(request);
  await mock.waitFor(1, delayMs + 4000);
  const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
  result('response', describe(mock.responses[0]));
  result('observed', `${elapsedMs.toFixed(1)} ms from write to framed response`);
  result('filter', `tcp.port == ${mock.localPort}`);
  await mock.close();

  await control.write(
    encodeRequest({
      operation: 'CLOSE_SESSION',
      headers: {
        [SLTP_HEADER.requestId]: `${context.tag}-close`,
        [SLTP_HEADER.sessionId]: sessionId,
      },
    }),
  );
  await control.waitFor(3);
  await control.close();
}

async function scenarioMalformed(context) {
  // Deliberately invalid: Content-Length must be an unsigned decimal integer, so a
  // negative value cannot be used to find the end of the body. The stream cannot be
  // resynchronised and the connection is fatal.
  const bytes = Buffer.from(
    `SLTP/1.0 PING\r\n${SLTP_HEADER.requestId}: ${context.tag}-bad\r\nContent-Length: -5\r\n\r\n`,
    'utf8',
  );
  const connection = await open(context.host, context.port);

  announce('malformed — an unusable Content-Length', {
    time: now(),
    target: `${context.host}:${context.port}  (control server)`,
    local: connection.local,
    'Request-ID': `${context.tag}-bad`,
    request: `${bytes.length} bytes in 1 application write, bypassing the encoder`,
    invalid: 'Content-Length: -5',
    expect:
      '400 BAD REQUEST carrying Connection: close, then a FIN. The framing is ' +
      'unrecoverable, so the peer says it is closing rather than leaving it to be inferred.',
  });

  await connection.write(bytes);
  await connection.waitFor(1);
  result('response', describe(connection.responses[0]));
  result('filter', `tcp.port == ${connection.localPort}`);
  await connection.close();
}

async function scenarioDisconnect(context) {
  // A header block promising 400 body bytes, followed by 12 and a hard close. The
  // peer is left holding an incomplete message it can never finish framing.
  const promised = 400;
  const head = Buffer.from(
    `SLTP/1.0 PING\r\n${SLTP_HEADER.requestId}: ${context.tag}-cut\r\n` +
      `Content-Type: application/json; charset=utf-8\r\nContent-Length: ${promised}\r\n\r\n`,
    'utf8',
  );
  const partial = Buffer.from('{"echo":"cut', 'utf8');
  const connection = await open(context.host, context.port);

  announce('disconnect — the stream stops mid-body', {
    time: now(),
    target: `${context.host}:${context.port}  (control server)`,
    local: connection.local,
    'Request-ID': `${context.tag}-cut`,
    request: `${head.length} header bytes + ${partial.length} of ${promised} promised body bytes`,
    expect:
      'no response. The peer is still waiting for ' +
      `${promised - partial.length} more body bytes when the connection is destroyed. ` +
      'Wireshark shows RST (or FIN) with the message incomplete.',
  });

  await connection.write(head);
  await connection.write(partial);
  await sleep(150);
  result('response', describe(connection.responses[0]));
  result('filter', `tcp.port == ${connection.localPort}`);
  connection.socket.destroy();
  await sleep(50);
}

async function scenarioConcurrent(context) {
  const count = 3;
  announce('concurrent — three connections at once', {
    time: now(),
    target: `${context.host}:${context.port}  (control server)`,
    local: 'one local port per connection, listed below',
    'Request-IDs': Array.from({ length: count }, (_, i) => `${context.tag}-conc-${i + 1}`).join(
      ', ',
    ),
    expect:
      'three independent TCP streams, each with its own framing state. ' +
      'Each response carries the Request-ID of its own connection.',
  });

  const connections = await Promise.all(
    Array.from({ length: count }, () => open(context.host, context.port)),
  );

  await Promise.all(
    connections.map((connection, index) => {
      const requestId = `${context.tag}-conc-${index + 1}`;
      return connection.write(
        encodeRequest({
          operation: 'PING',
          headers: { [SLTP_HEADER.requestId]: requestId },
          body: JSON.stringify({ echo: requestId }),
          json: true,
        }),
      );
    }),
  );

  await Promise.all(connections.map((connection) => connection.waitFor(1)));
  for (const [index, connection] of connections.entries()) {
    const entry = connection.responses[0];
    result(
      `stream ${index + 1}`,
      `local ${connection.local} → ${describe(entry)}  Request-ID=${entry?.requestId ?? '—'}`,
    );
  }
  result('filter', `tcp.port == ${connections.map((c) => c.localPort).join(' || tcp.port == ')}`);
  await Promise.all(connections.map((connection) => connection.close()));
}

const SCENARIOS = [
  { name: 'ping', summary: 'one request, one response', run: scenarioPing },
  { name: 'utf8', summary: 'Content-Length counts bytes, not characters', run: scenarioUtf8 },
  {
    name: 'fragmentation',
    summary: 'one application message across many writes',
    run: scenarioFragmentation,
  },
  { name: 'coalescing', summary: 'two application messages in one write', run: scenarioCoalescing },
  { name: 'delay', summary: 'a slow mock reply on a session endpoint', run: scenarioDelay },
  { name: 'malformed', summary: 'an unusable Content-Length', run: scenarioMalformed },
  { name: 'disconnect', summary: 'the stream stops mid-body', run: scenarioDisconnect },
  { name: 'concurrent', summary: 'three simultaneous connections', run: scenarioConcurrent },
];

// ─── command line ────────────────────────────────────────────────────────────

const USAGE = `socketlens wireshark:demo — deterministic SLTP traffic for packet capture

  npm run wireshark:demo                        every scenario once
  npm run wireshark:demo -- --list
  npm run wireshark:demo -- --scenario fragmentation
  npm run wireshark:demo -- --loop --interval 2000
  npm run wireshark:demo -- --host 127.0.0.1 --port ${DEFAULT_CONTROL_PORT}

Options
  --scenario <name>   one scenario, or "all" (default: all)
  --once              run the selection once and exit (default)
  --loop              repeat until interrupted with Ctrl+C
  --interval <ms>     pause between iterations when looping (default 2000)
  --host <host>       control server host (default ${DEFAULT_HOST})
  --port <port>       control server port (default ${DEFAULT_CONTROL_PORT})
  --list              print the scenario names and exit
  --help              print this text

A SocketLens TCP server must already be running:  npm run start:server
Wireshark is optional. Without it, this is just a traffic generator.
Capture procedure: docs/wireshark-capture.md`;

function parseArgs(argv) {
  const options = {
    scenario: 'all',
    loop: false,
    intervalMs: 2000,
    host: DEFAULT_HOST,
    port: DEFAULT_CONTROL_PORT,
    list: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      index += 1;
      return argv[index];
    };

    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--list') options.list = true;
    else if (arg === '--loop') options.loop = true;
    else if (arg === '--once') options.loop = false;
    else if (arg === '--scenario') options.scenario = next() ?? 'all';
    else if (arg === '--host') options.host = next() ?? DEFAULT_HOST;
    else if (arg === '--interval') {
      const value = Number(next());
      if (!Number.isFinite(value) || value < 0) return { error: '--interval needs a number' };
      options.intervalMs = value;
    } else if (arg === '--port') {
      const value = Number(next());
      if (!Number.isInteger(value) || value < 1 || value > 65535) {
        return { error: '--port needs a valid TCP port' };
      }
      options.port = value;
    } else {
      return { error: `Unknown argument: ${String(arg)}` };
    }
  }

  if (options.scenario !== 'all' && !SCENARIOS.some((s) => s.name === options.scenario)) {
    return {
      error: `Unknown scenario: ${options.scenario}. Try --list.`,
    };
  }
  return options;
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.error !== undefined) {
    console.error(`${options.error}\n`);
    console.error(USAGE);
    return 1;
  }
  if (options.help) {
    console.log(USAGE);
    return 0;
  }
  if (options.list) {
    console.log('Scenarios:');
    for (const scenario of SCENARIOS) {
      console.log(`  ${scenario.name.padEnd(16)}${scenario.summary}`);
    }
    return 0;
  }

  const selected =
    options.scenario === 'all' ? SCENARIOS : SCENARIOS.filter((s) => s.name === options.scenario);

  console.log('SocketLens TCP — Wireshark traffic generator');
  console.log(`target      ${options.host}:${options.port}`);
  console.log(`scenarios   ${selected.map((s) => s.name).join(', ')}`);
  console.log(`mode        ${options.loop ? `loop every ${options.intervalMs} ms` : 'once'}`);
  console.log('');
  console.log('Each scenario prints its local TCP port. In Wireshark, filter on that port');
  console.log('to isolate the exchange, then right-click a packet → Follow → TCP Stream.');
  console.log('Note: the write counts below are application writes. The number of TCP');
  console.log('segments the OS produces is decided by the OS and may differ.');

  let iteration = 0;
  let stopping = false;
  process.on('SIGINT', () => {
    stopping = true;
    console.log('\ninterrupted — finishing the current scenario, then stopping.');
  });

  do {
    iteration += 1;
    const tag = options.loop ? `ws${iteration}` : 'ws';
    for (const scenario of selected) {
      if (stopping) break;
      try {
        await scenario.run({ host: options.host, port: options.port, tag });
      } catch (cause) {
        console.error(`\nscenario ${scenario.name} failed: ${cause.message}`);
        // A refused connection means no server is running; nothing else will work.
        if (String(cause.message).includes('No SLTP server is listening')) return 1;
      }
    }
    if (options.loop && !stopping) await sleep(options.intervalMs);
  } while (options.loop && !stopping);

  console.log('');
  console.log(`done — ${counter} exchange(s) generated.`);
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((cause) => {
    console.error(`wireshark:demo failed: ${cause.message}`);
    process.exitCode = 1;
  });
