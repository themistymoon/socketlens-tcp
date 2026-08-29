# Wireshark evidence — 2026-08-29

This directory records SLTP/1.0 traffic generated from commit `4d1c6a1` on the Windows
development machine with Wireshark/TShark 4.6.7 and Npcap 1.88. Capture used Npcap's
`\Device\NPF_Loopback` interface and the BPF capture filter `tcp port 7420`.

## Packet captures

| File                                  | Packets | SHA-256                                                            | Scope                                                                  |
| ------------------------------------- | ------: | ------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| `socketlens-essential-4d1c6a1.pcapng` |      56 | `5C087ACE7B5DF874AFD7F8C82C7FA1C450EEF3E38D6E8ECA12C8793DF34012E1` | Compact fallback containing the four core demonstration scenarios      |
| `socketlens-full-4d1c6a1.pcapng`      |     129 | `AEFC4EA1FECF9959C45F23C3027B4255AEA60673B5CD25028174B2E6BBEA225F` | One complete run of all eight generators, limited to control port 7420 |

The full capture contains ten TCP streams. The generator's client-side ports map as follows:

| Stream | Client port(s)   | Scenario        | Observed payload summary                                       |
| -----: | ---------------- | --------------- | -------------------------------------------------------------- |
|      0 | 6468             | `ping`          | 38-byte request, 271-byte response                             |
|      1 | 6469             | `utf8`          | 152-byte request, 318-byte response                            |
|      2 | 6470             | `fragmentation` | six request segments: 6, 14, 18, 24, 40, and 33 bytes          |
|      3 | 6471             | `coalescing`    | one 247-byte request segment, two responses: 289 and 290 bytes |
|      4 | 6472             | `delay` control | control exchange that configured and queried the mock          |
|      5 | 6475             | `malformed`     | 57-byte malformed request, 304-byte response, then FIN         |
|      6 | 6476             | `disconnect`    | incomplete request followed by client disconnect               |
|    7–9 | 6478, 6479, 6480 | `concurrent`    | three independent streams, each with a 293-byte response       |

The `delay` scenario also opened a separate mock-endpoint connection. That connection is
intentionally absent because the capture filter was restricted to port 7420. The application
reported an observed delay of 767.8 ms; this packet file is not presented as packet-level
evidence for that mock-endpoint timing.

## Screenshot manifest

| File                                        | Claim shown                                                            |
| ------------------------------------------- | ---------------------------------------------------------------------- |
| `01-capture-overview.jpg`                   | Saved loopback capture overview                                        |
| `02-ping-filtered.jpg`                      | One PING exchange isolated by client port                              |
| `03-ping-follow-stream.jpg`                 | Complete plaintext SLTP request and response                           |
| `04-ping-hex-framing.jpg`                   | CRLF header lines and the `0d 0a 0d 0a` header terminator              |
| `05-fragmentation-six-writes.jpg`           | Six payload-carrying request segments observed in this loopback run    |
| `06-coalescing-one-write-two-responses.jpg` | A 247-byte client send followed by two server responses                |
| `07-malformed-400-close.jpg`                | `400 BAD REQUEST` with `Connection: close`                             |
| `08-loopback-interface.jpg`                 | Npcap loopback adapter in Wireshark's interface list                   |
| `09-utf8-byte-length.jpg`                   | UTF-8 bytes and the JSON message's byte-counted `Content-Length`       |
| `10-coalescing-follow-stream.jpg`           | Two consecutive SLTP requests decoded from one coalesced byte sequence |
| `11-malformed-fin-close.jpg`                | Server FIN after the fatal malformed request response                  |

All screenshots were captured with the mouse pointer parked outside the Wireshark window.
Application writes, Node.js `data` events, and TCP segments are different boundaries; the
screenshots only claim what is observable in the packet capture.
