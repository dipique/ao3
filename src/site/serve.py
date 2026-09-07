#!/usr/bin/env python3
"""Serve a folder of AO3 Enhancements exports on your local network.

    python3 serve.py              # port 8765, reachable from other devices
    python3 serve.py 9000         # a different port
    python3 serve.py --host 127.0.0.1   # this machine only

Standard library only, Python 3.7+. Serves the folder this file lives in, so
drop it beside your exports and run it from anywhere.

An export is one self-contained HTML file, and most browsers will open one
straight off the device with nothing serving it at all. Safari will not: it
refuses to run scripts in a local file. So for a reader who would rather not
install a second browser, a served address is the only way in, and that is what
this is for. It is not what decides whether an export can save anything - what
it saves (marks, filters, layout) it saves either way.

There is no index page. The exports are the pages, so the root is a listing of
them.
"""

from __future__ import annotations

import argparse
import http.server
import os
import socket
import sys
from functools import partial

DEFAULT_PORT = 8765
HERE = os.path.dirname(os.path.abspath(__file__))

# Windows resolves media types through the registry, where .js is regularly
# mapped to text/plain — which browsers refuse to execute. Pin the handful of
# types these pages actually serve rather than trusting the machine's mapping.
TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".woff2": "font/woff2",
    ".txt": "text/plain; charset=utf-8",
}


class Server(http.server.ThreadingHTTPServer):
    # SO_REUSEADDR means two different things. On POSIX it lets a restart rebind a
    # port still in TIME_WAIT — worth having. On Windows it lets a second server
    # bind a port that is *actively* in use, so a repeated launch silently leaves
    # two servers fighting over one port instead of reporting the clash.
    allow_reuse_address = os.name != "nt"


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, **TYPES}

    def log_message(self, fmt, *args):
        # One tidy line per request; the default also prints the date twice.
        sys.stderr.write("  %s\n" % (fmt % args))


def lan_address() -> str | None:
    """This machine's address on the LAN, for the "open this on your iPad" line.

    Opening a UDP socket to a documentation address sends no packets; it just
    asks the OS which interface it would route from.
    """
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        sock.connect(("192.0.2.1", 53))
        return sock.getsockname()[0]
    except OSError:
        return None
    finally:
        sock.close()


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Serve a folder of AO3 Enhancements exports.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "port", nargs="?", type=int, default=None,
        help=f"port to listen on (default {DEFAULT_PORT})",
    )
    parser.add_argument(
        "-p", "--port", dest="port_opt", metavar="PORT", type=int, default=None,
        help="the same thing, spelled the other way",
    )
    parser.add_argument(
        "--host", default="0.0.0.0",
        help="address to bind (default 0.0.0.0, i.e. reachable from your network; "
             "pass 127.0.0.1 to keep it to this machine)",
    )
    args = parser.parse_args()
    port = args.port if args.port is not None else (args.port_opt or DEFAULT_PORT)

    try:
        server = Server((args.host, port), partial(Handler, directory=HERE))
    except OSError as err:
        # Printed text stays ASCII: a Windows console on a legacy code page turns
        # anything else into replacement characters.
        print(f"Could not listen on {args.host}:{port} - {err}", file=sys.stderr)
        print(f"Something else may be using that port; try: python3 serve.py {port + 1}", file=sys.stderr)
        return 1

    exports = sorted(f for f in os.listdir(HERE) if f.lower().endswith(".html"))
    found = f"{len(exports)} export(s)" if exports else "no exports yet - put an .html export here"
    lines = [f"Serving {HERE} ({found})", f"  this machine    http://localhost:{port}/"]
    if args.host not in ("127.0.0.1", "localhost"):
        ip = lan_address()
        if ip:
            lines.append(f"  on your network http://{ip}:{port}/   <- open this on the iPad")
        lines.append("  (anyone on your network can read this library while the server runs)")
    lines.append("Ctrl+C to stop.\n")
    # flush: stdout is block-buffered when this is piped to a file or a service
    # manager, and the address is the one thing worth seeing immediately.
    print("\n".join(lines), flush=True)

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
