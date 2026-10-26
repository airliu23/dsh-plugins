#!/usr/bin/env python3
"""Serial bridge for the DSH ``@local/serial-monitor`` plugin.

The Host half spawns this script with ``python -u`` and reads one JSON object
per line (NDJSON) from stdout.  Keeping the serial work in Python means the
panel reuses the same pyserial stack as ``tools/uart_capture.py`` instead of
needing a native Node addon.

Commands:
    python -u serial_sidecar.py list
    python -u serial_sidecar.py probe --port COM23 --baud 9600 --ms 1500
    python -u serial_sidecar.py read  --port COM23 --baud 9600
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
import threading
import time


def emit(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def lock_path(port: str, baud: int, owner: str) -> str:
    """Per-(host pid) lock naming the process holding a port, so a reloaded
    Host can kill the capture its previous instance left behind."""
    base = os.path.join(tempfile.gettempdir(), "dsh-serial-monitor")
    os.makedirs(base, exist_ok=True)
    return os.path.join(base, f"{port}@{baud}.{owner}.lock")


def load_serial():
    try:
        import serial  # noqa: F401
    except ImportError:
        emit({
            "type": "error",
            "message": "pyserial 未安装：python -m pip install pyserial",
        })
        return None
    return serial


def list_ports_payload():
    from serial.tools import list_ports

    ports = []
    for info in list_ports.comports():
        ports.append({
            "device": info.device,
            "description": (info.description or "").strip(),
            # Hardware id separates two identical CH341 bridges, and lets the
            # Host skip Bluetooth pseudo-ports.
            "hwid": (info.hwid or "").strip(),
        })
    return ports


def cmd_list() -> int:
    if load_serial() is None:
        return 2
    try:
        ports = list_ports_payload()
    except Exception as exc:  # noqa: BLE001 - enumeration must never kill the bridge
        emit({"type": "error", "message": f"枚举串口失败：{exc}"})
        return 2
    emit({"type": "ports", "ports": ports})
    return 0


def cmd_read(port: str, baud: int, owner: str) -> int:
    serial = load_serial()
    if serial is None:
        return 2
    try:
        handle = serial.Serial(port, baud, timeout=0.2)
    except Exception as exc:  # noqa: BLE001 - report to the panel, do not traceback
        emit({"type": "error", "message": f"打不开 {port} @{baud}：{exc}"})
        return 2
    emit({"type": "opened", "port": port, "baud": baud, "pid": os.getpid()})
    lock = lock_path(port, baud, owner)
    try:
        with open(lock, "w", encoding="utf-8") as handle_lock:
            handle_lock.write(str(os.getpid()))
    except Exception:  # noqa: BLE001 - locking is best effort
        lock = None

    # The Host stops a capture by sending "quit" (or closing stdin). Closing the
    # COM handle from here also aborts a read() that some USB-serial drivers
    # never time out, so the port is handed back promptly and cleanly.
    def watch_parent() -> None:
        try:
            while True:
                line = sys.stdin.readline()
                if line == "" or line.strip() == "quit":
                    break
        except Exception:  # noqa: BLE001 - a closed pipe is the normal path
            pass
        stop.set()
        try:
            handle.close()
        except Exception:  # noqa: BLE001 - already closed
            pass

    stop = threading.Event()
    threading.Thread(target=watch_parent, daemon=True).start()
    try:
        while not stop.is_set():
            try:
                chunk = handle.read(4096)
            except Exception as exc:  # noqa: BLE001
                if stop.is_set():
                    break
                emit({"type": "error", "message": f"读取中断：{exc}"})
                return 1
            if chunk:
                emit({
                    "type": "data",
                    # Firmware logs are ASCII; replacement keeps a stray binary
                    # byte from breaking the JSON line.
                    "text": chunk.decode("utf-8", errors="replace"),
                })
    except KeyboardInterrupt:
        pass
    finally:
        try:
            handle.close()
        except Exception:  # noqa: BLE001
            pass
        if lock is not None:
            try:
                os.remove(lock)
            except Exception:  # noqa: BLE001
                pass
    emit({"type": "closed"})
    return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="cmd")

    sub.add_parser("list", help="list serial ports as NDJSON")

    read = sub.add_parser("read", help="stream one port as NDJSON data lines")
    read.add_argument("--port", required=True)
    read.add_argument("--baud", type=int, default=9600)
    read.add_argument("--owner", default="0", help="Host pid; names this capture's lock file")

    args = parser.parse_args()
    if args.cmd == "list":
        return cmd_list()
    if args.cmd == "read":
        return cmd_read(args.port, args.baud, args.owner)
    parser.print_help()
    return 2


if __name__ == "__main__":
    sys.exit(main())
