#!/usr/bin/env python3
"""Test double for `serial_sidecar.py` — no hardware involved.

Speaks the same NDJSON protocol on stdout, so the Host half cannot tell the
difference: the whole chain (spawn → stdout parse → ring buffer → push frame →
tool read) is exercised for real, only the bytes are synthetic.

    python -u fake-sidecar.py list
    python -u fake-sidecar.py read --port COM1 --baud 9600 --owner <pid>
"""
import json
import sys
import threading

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

    counter = 0
    while not stop.is_set():
        counter += 1
        emit({"type": "data", "text": "[tx] line %d\n" % counter})
        stop.wait(LINE_DELAY_SECONDS)

    emit({"type": "closed"})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
