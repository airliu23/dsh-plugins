#!/usr/bin/env python3
"""Test double for `serial_sidecar.py` — no hardware involved.

Speaks the same NDJSON protocol on stdout, so the Host half cannot tell the
difference: the whole chain (spawn → stdout parse → ring buffer → push frame →
tool read) is exercised for real, only the bytes are synthetic.

    python -u fake-sidecar.py list
    python -u fake-sidecar.py read --port COM1 --baud 9600 --owner <pid>
"""
import json
import os
import sys
import threading
import time

LINE_DELAY_SECONDS = 0.02


def emit(payload):
    sys.stdout.write(json.dumps(payload) + "\n")
    sys.stdout.flush()


def main():
    command = sys.argv[1] if len(sys.argv) > 1 else "list"
    if command == "list":
        emit({"ports": []})
        return 0
    if command != "read":
        return 2

    port, baud = "COM0", 9600
    for index, argument in enumerate(sys.argv):
        if argument == "--port" and index + 1 < len(sys.argv):
            port = sys.argv[index + 1]
        elif argument == "--baud" and index + 1 < len(sys.argv):
            baud = int(sys.argv[index + 1])

    emit({"type": "opened", "port": port, "baud": baud, "pid": 0})

    stop = threading.Event()

    def watch_stdin():
        for line in sys.stdin:
            if line.strip() == "quit":
                stop.set()
                return

    threading.Thread(target=watch_stdin, daemon=True).start()

    # FAKE_BURST_BYTES turns the double into a bandwidth test: push that many
    # bytes as fast as the pipe takes them, the way a 1.5 Mbaud dump arrives in
    # one go. Nothing else is emitted afterwards, so the byte count and the
    # character count can be compared exactly.
    burst = int(os.environ.get("FAKE_BURST_BYTES", "0") or "0")
    sent = 0
    if burst > 0:
        line = b"[tx] " + b"a" * 79 + b"\n"
        chunk = b""
        while sent < burst and not stop.is_set():
            chunk += line
            sent += len(line)
            if len(chunk) >= 16 * 1024:
                text = chunk.decode("utf-8")
                chunk = b""
                emit({"type": "data", "text": text})
                emit({"type": "stats", "bytes": sent})
        if chunk:
            emit({"type": "data", "text": chunk.decode("utf-8")})
            chunk = b""
            emit({"type": "stats", "bytes": sent})
        while not stop.is_set():
            stop.wait(0.1)
        emit({"type": "stats", "bytes": sent})
        emit({"type": "closed"})
        return 0

    counter = 0
    last_stats = time.monotonic()
    # FAKE_REOPEN_MS simulates a driver hiccup: the capture dies and comes back
    # on a fresh process, whose byte counter starts at zero again.
    reopen_at = float(os.environ.get("FAKE_REOPEN_MS", "0") or "0") / 1000.0
    started = time.monotonic()
    reopened = False
    while not stop.is_set():
        if reopen_at > 0 and not reopened and time.monotonic() - started >= reopen_at:
            reopened = True
            emit({"type": "opened", "port": port, "baud": baud, "pid": 0})
            sent = 0
        counter += 1
        line = "[tx] line %d\n" % counter
        sent += len(line.encode("utf-8"))
        emit({"type": "data", "text": line})
        # Mirror the real sidecar's wire-byte accounting.
        if time.monotonic() - last_stats >= 0.1:
            emit({"type": "stats", "bytes": sent})
            last_stats = time.monotonic()
        stop.wait(LINE_DELAY_SECONDS)

    emit({"type": "stats", "bytes": sent})
    emit({"type": "closed"})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
