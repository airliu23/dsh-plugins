#!/usr/bin/env python3
"""Serial bridge for the DSH ``@local/serial-monitor`` plugin.

The Host half spawns this script with ``python -u`` and reads one JSON object
per line (NDJSON) from stdout.  Keeping the serial work in Python means the
panel reuses the same pyserial stack as ``tools/uart_capture.py`` instead of
needing a native Node addon.

Commands:
    python -u serial_sidecar.py list
    python -u serial_sidecar.py read  --port COM23 --baud 9600

Why the read loop is split in two threads: at 1.5 Mbaud the wire carries
~150 KB/s, and a Windows serial queue is only a few KB deep (a few tens of
milliseconds of slack).  Anything that blocks the reader — JSON encoding, a
pipe that nobody drains, a GC pause in the middle of the loop — overflows that
queue and the *driver* silently drops bytes.  So one thread does nothing but
drain the handle into memory, and a second one batches those bytes into NDJSON
frames.  ``stats`` frames report how many bytes were actually read off the
wire, which is what lets the Host prove whether anything was lost.
"""
from __future__ import annotations

import argparse
import codecs
import json
import os
import queue
import sys
import tempfile
import threading
import time

# One read() call stalls at most this long; small enough to keep the OS queue
# short, large enough that the loop is not pure syscall overhead.
READ_TIMEOUT_SECONDS = 0.02
# Coalesce what arrived into one frame: 16 KB or 15 ms, whichever comes first.
FLUSH_BYTES = 16 * 1024
FLUSH_SECONDS = 0.015
STATS_SECONDS = 0.25
# Windows only: ask the driver for a deep receive queue (two seconds of wire at
# 1.5 Mbaud).  pyserial raises on other platforms, which is fine.
RX_BUFFER_BYTES = 2 * 1024 * 1024


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


class BytePump:
    """Drain a serial handle in one thread, batch it into frames in another.

    Split out of :func:`cmd_read` so it can be exercised against a fake handle
    (see ``test/sidecar_selftest.py``) without a port or pyserial.
    """

    def __init__(
        self,
        handle,
        stop: threading.Event,
        emit_fn=emit,
        read_size: int = 65536,
        read_timeout: float = READ_TIMEOUT_SECONDS,
        flush_bytes: int = FLUSH_BYTES,
        flush_seconds: float = FLUSH_SECONDS,
        stats_seconds: float = STATS_SECONDS,
    ) -> None:
        self.handle = handle
        self.stop = stop
        self.emit = emit_fn
        self.read_size = read_size
        self.read_timeout = read_timeout
        self.flush_bytes = flush_bytes
        self.flush_seconds = flush_seconds
        self.stats_seconds = stats_seconds
        self.frames: queue.Queue = queue.Queue()
        self.total_bytes = 0
        self.frames_sent = 0

    # --- reader ---------------------------------------------------------
    def _reader(self) -> None:
        while not self.stop.is_set():
            try:
                chunk = self.handle.read(self.read_size)
            except Exception as exc:  # noqa: BLE001 - reported by the pump loop
                if self.stop.is_set():
                    return
                self.frames.put(exc)
                return
            if chunk:
                self.frames.put(chunk)

    # --- batcher --------------------------------------------------------
    def run(self) -> int:
        decoder = codecs.getincrementaldecoder("utf-8")("replace")
        threading.Thread(target=self._reader, daemon=True).start()
        pending: list[bytes] = []
        pending_bytes = 0
        now = time.monotonic()
        last_flush = now
        last_stats = now
        status = 0

        def flush(final: bool = False) -> None:
            nonlocal pending, pending_bytes, last_flush
            if not pending and not final:
                return
            text = decoder.decode(b"".join(pending), final)
            pending = []
            pending_bytes = 0
            last_flush = time.monotonic()
            if text:
                self.frames_sent += 1
                self.emit({"type": "data", "text": text})

        while not self.stop.is_set():
            try:
                item = self.frames.get(timeout=self.read_timeout)
            except queue.Empty:
                item = None
            if isinstance(item, Exception):
                flush()
                self.emit({"type": "error", "message": f"读取中断：{item}"})
                return 1
            if item:
                pending.append(item)
                pending_bytes += len(item)
                self.total_bytes += len(item)
            now = time.monotonic()
            if pending_bytes >= self.flush_bytes or (pending_bytes and now - last_flush >= self.flush_seconds):
                flush()
            if now - last_stats >= self.stats_seconds:
                # The wire byte count, not the character count: this is the
                # number the Host compares against to detect loss.
                self.emit({"type": "stats", "bytes": self.total_bytes})
                last_stats = now

        flush(final=True)
        self.emit({"type": "stats", "bytes": self.total_bytes})
        return status


def cmd_read(port: str, baud: int, owner: str) -> int:
    serial = load_serial()
    if serial is None:
        return 2
    try:
        handle = serial.Serial(port, baud, timeout=READ_TIMEOUT_SECONDS)
    except Exception as exc:  # noqa: BLE001 - report to the panel, do not traceback
        emit({"type": "error", "message": f"打不开 {port} @{baud}：{exc}"})
        return 2
    try:
        handle.set_buffer_size(rx_size=RX_BUFFER_BYTES, tx_size=64 * 1024)
    except Exception:  # noqa: BLE001 - POSIX or a driver that refuses; not fatal
        pass
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
    stop = threading.Event()

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

    threading.Thread(target=watch_parent, daemon=True).start()
    pump = BytePump(handle, stop)
    try:
        pump.run()
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
    emit({"type": "closed", "bytes": pump.total_bytes})
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
