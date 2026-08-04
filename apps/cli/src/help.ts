/**
 * `--help` output.
 *
 * The help text is part of the deliverable: a reader who has never seen SLTP should
 * be able to run a complete demonstration from this text alone.
 */
import { DEFAULT_CONTROL_PORT, DEFAULT_HOST, DEFAULT_TIMEOUT_MS } from '@socketlens/protocol';

/** Top-level usage. */
export const USAGE = `SocketLens TCP — SLTP command-line client

  A local developer tool for designing, mocking, testing, and debugging custom
  application-layer protocols over raw TCP streams. This client speaks SLTP
  (SocketLens Testing Protocol) over a raw TCP socket. There is no HTTP involved.

USAGE
  socketlens <command> [options]
  socketlens repl                     interactive mode, one connection reused

CONNECTIVITY
  ping                                PING the server; prints status, phrase, uptime
  info                                SERVER_INFO: limits, capabilities, registries
  raw                                 write uncorrelated bytes; shows how the server
                                      answers malformed input

SESSIONS
  session create                      CREATE_SESSION; starts a dedicated TCP mock
                                      endpoint on an ephemeral port
  session list                        LIST_SESSIONS
  session show [<id>]                 GET_SESSION, including the mock endpoint address
  session use <id>                    remember <id> as the default for later commands
  session close [<id>]                CLOSE_SESSION; stops the mock endpoint

MOCK RULES
  rule add                            ADD_RULE
  rule list                           LIST_RULES, in evaluation order
  rule update <ruleId>                UPDATE_RULE
  rule delete <ruleId>                DELETE_RULE

TESTS
  run [<file.json>]                   RUN_TEST for each scenario in a bundle, or an
                                      ad-hoc scenario built from flags
  scenario show <file.json>           validate and describe a scenario file
  result list                         LIST_RESULTS
  result show <resultId>              GET_RESULT, with assertions and TCP segments
  result export --out <file>          write every stored result to JSON

REFERENCE
  help operations                     print the SLTP operation registry
  help status                         print the SLTP status registry

GLOBAL OPTIONS
  -h, --host <host>                   server host (default ${DEFAULT_HOST})
  -p, --port <port>                   server port (default ${DEFAULT_CONTROL_PORT})
      --timeout <ms>                  response timeout (default ${DEFAULT_TIMEOUT_MS})
  -s, --session <id>                  act on this session, ignoring the remembered one
      --raw                           print the exact bytes of every message
  -v, --verbose                       print full protocol traffic
  -q, --quiet                         print no protocol traffic
      --json                          machine-readable output
      --no-color                      disable ANSI colour
      --help                          show help; after a command, show its help
  -V, --version                       print the version

ENVIRONMENT
  SOCKETLENS_HOST, SOCKETLENS_PORT    default server address
  SOCKETLENS_STATE_FILE               where the remembered session is stored
  NO_COLOR                            disable colour

EXAMPLES
  Start the server in another terminal first:
    npm run dev:server

  A complete demonstration:
    socketlens ping --raw
    socketlens session create --name demo
    socketlens rule add --name pong --operation PING --status 200 --body '{"reply":"pong"}'
    socketlens rule list
    socketlens run --operation PING --expect-status 200 --raw
    socketlens result list

  Prove that TCP does not preserve message boundaries:
    socketlens run --operation PING --fragment 12,8,40 --raw

  Show the server rejecting a malformed message:
    socketlens raw --text 'SLTP/1.0 PING\\r\\nContent-Length: -5\\r\\n\\r\\n'
`;

/** Per-command help, keyed by the joined command path. */
const COMMAND_HELP: Readonly<Record<string, string>> = {
  ping: `socketlens ping [--echo <value>]

  Sends PING and prints the response. Use --raw to see the exact bytes.

  --echo <value>    value the server echoes back, proving the body round-tripped`,

  info: `socketlens info

  Sends SERVER_INFO and prints the server's protocol version, configured limits,
  capabilities, operation registry, status registry, and current counts.`,

  'session create': `socketlens session create [--name <name>] [--description <text>]

  Creates an isolated testing session. The server starts a dedicated TCP mock
  endpoint for it on an operating-system-assigned port, and scenarios connect to
  that endpoint over a real TCP socket.

  The new session becomes the default for later commands.`,

  'session list': `socketlens session list

  Lists every session, with each one's mock endpoint address and counts.`,

  'session show': `socketlens session show [<sessionId>]

  Shows one session. Defaults to the remembered session.`,

  'session use': `socketlens session use <sessionId>

  Verifies the session exists, then remembers it as the default.`,

  'session close': `socketlens session close [<sessionId>]

  Closes the session and stops its mock endpoint. Stored results stay readable;
  further session-scoped operations are refused with 405 OPERATION NOT ALLOWED.`,

  'rule add': `socketlens rule add [--file <path> | --json-body <json> | flags]

  Installs a mock response rule. Rules are evaluated by priority descending, then
  by insertion order ascending, so the ordering is deterministic.

  --name <name>          rule name, unique within the session (required for flag form)
  --operation <OP>       operation to match, or * for any (default *)
  --header "N: v"        header that must be present; repeat with commas
  --status <code>        response status code (default 200)
  --phrase <text>        response status phrase (default: the registered phrase)
  --body <text>          response body
  --priority <n>         higher wins (default 0)
  --delay <ms>           delay before the mock writes the response
  --fragment <a,b,c>     write the response in TCP segments of these sizes
  --file <path>          read the whole rule from a JSON file
  --json-body <json>     read the whole rule from an inline JSON string`,

  'rule list': `socketlens rule list

  Lists the session's rules in the exact order the matcher evaluates them.`,

  'rule update': `socketlens rule update <ruleId> [flags]

  Changes fields on an existing rule.

  --name <name>       rename
  --priority <n>      change priority
  --enable            enable the rule
  --disable           disable the rule
  --file <path>       read a JSON patch from a file
  --json-body <json>  read a JSON patch inline`,

  'rule delete': `socketlens rule delete <ruleId>

  Removes a rule from the session.`,

  run: `socketlens run [<file.json>] [flags]

  Executes one or more scenarios. The server opens a real TCP connection to the
  session's mock endpoint, writes the request as the scenario specifies, and records
  every TCP segment, so fragmentation and coalescing are directly observable.

  <file.json>            scenario bundle, or a single bare scenario object
  --file <path>          same as the positional argument
  --json-body <json>     inline scenario JSON
  --scenario <name>      run only the named scenario from the bundle
  --no-install-rules     do not install the bundle's rules first

  Ad-hoc scenario, when no file is given:
  --operation <OP>       operation to send (required)
  --name <name>          scenario name
  --body <text>          request body
  --header "N: v"        request header
  --fragment <a,b,c>     write the request in TCP segments of these sizes
  --delay <ms>           delay between fragments
  --timeout <ms>         scenario timeout
  --expect-status <code> assert the response status code

  Exits non-zero when any scenario fails, so it is usable in a script.`,

  'scenario show': `socketlens scenario show <file.json>

  Validates a scenario file and describes what it would do, without running it.
  Every problem in the file is reported at once.`,

  'result list': `socketlens result list

  Lists stored results for the session, with pass and fail counts.`,

  'result show': `socketlens result show <resultId>

  Shows one result: expected versus actual for each assertion, the TCP segments
  observed, and — with --raw — the exact bytes sent and received.

  Exits non-zero when the result is a failure.`,

  'result export': `socketlens result export --out <file>

  Fetches every stored result for the session and writes them to a JSON file.`,

  raw: `socketlens raw (--text <bytes> | --file <path>) [--timeout <ms>]

  Writes bytes onto the socket with no encoding and no Request-ID correlation, then
  prints whatever arrives within the window. This is how to demonstrate the server's
  handling of malformed framing.

  In --text, the escapes \\r, \\n, and \\t become real control characters, because a
  shell cannot easily produce a carriage return.

  --text <bytes>    payload, with \\r\\n escapes
  --file <path>     payload read verbatim from a file
  --timeout <ms>    how long to wait for a reply (default 1000)`,

  repl: `socketlens repl

  Interactive mode. One TCP connection is opened and reused for every command, which
  is what makes Request-ID correlation observable: several requests may be in flight
  on the same connection at once.

  Inside the prompt, type any command without the "socketlens" prefix. Type "help"
  for the command list, "raw on" to toggle raw byte output, and "exit" to disconnect.`,
};

/** Returns the help text for a command path, or the top-level usage. */
export function helpFor(command: readonly string[]): string {
  if (command.length === 0) return USAGE;
  const key = command.join(' ');
  return COMMAND_HELP[key] ?? USAGE;
}

/** Help shown inside the interactive prompt. */
export const REPL_HELP = `Commands (the "socketlens" prefix is implied)

  ping [--echo v]              info
  session create [--name n]    session list          session show [id]
  session use <id>             session close [id]
  rule add --name n …          rule list             rule update <id> …
  rule delete <id>
  run [file.json] [flags]      scenario show <file>
  result list                  result show <id>      result export --out <file>
  raw --text '…'

Prompt controls
  raw on | raw off             toggle printing of exact message bytes
  verbose | quiet              change protocol logging verbosity
  session                      show the currently selected session
  help [command]               this list, or help for one command
  exit | quit                  disconnect and leave
`;
