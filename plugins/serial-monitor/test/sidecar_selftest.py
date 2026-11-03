#!/usr/bin/env python3
"""Unit test for the sidecar's read pump — no port, no pyserial.

The pump is what stands between the wire and the Host: if it loses a chunk, the
panel loses a chunk.  What is asserted here:

  1. every byte handed to the pump comes back out exactly once (no loss, no
     duplication) even when reads return small, awkwardly sized slices;
  2. a multi-byte UTF-8 character split across two reads is not mangled into
     replacement characters;
  3. frames are batched (fewer, larger) instead of one frame per read;
  4. the running byte count in `stats` matches the bytes read off the wire.

    python test/sidecar_selftest.py
"""
import os
import sys
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

import serial_sidecar  # noqa: E402

failures = []


def check(label, condition, detail=None):
    print(("PASS " if condition else "FAIL ") + label + ("" if detail is None else " — %s" % detail))
    if not condition:
        failures.append(label)


class FakeHandle:
    """Hands out fixed-size slices of a payload, like a driver with a small queue."""

    def __init__(self, payload, slice_size):
        self.payload = payload
        self.slice_size = slice_size
        self.offset = 0

    def read(self, _size):
        if self.offset >= len(self.payload):
            time.sleep(0.001)
            return b""
        chunk = self.payload[self.offset:self.offset + self.slice_size]
        self.offset += len(chunk)
        return chunk


def run_pump(payload, slice_size, stop_after):
    frames = []
    stop = threading.Event()
    pump = serial_sidecar.BytePump(
        FakeHandle(payload, slice_size),
        stop,
        emit_fn=frames.append,
        read_timeout=0.002,
        flush_bytes=1024,
        flush_seconds=0.005,
        stats_seconds=0.05,
    )
    thread = threading.Thread(target=lambda: pump.run())
    thread.start()
    time.sleep(stop_after)
    stop.set()
    thread.join(timeout=2)
    return frames, pump


payload = ("[tx] 时间 1234567890 boot done\n" * 400).encode("utf-8")
# 21 bytes per line, and the Chinese characters sit near the cursor boundary, so
# a naive per-chunk decode would split them.
frames, pump = run_pump(payload, slice_size=37, stop_after=0.9)

data_frames = [frame for frame in frames if frame.get("type") == "data"]
text = "".join(frame["text"] for frame in data_frames)
expected = payload.decode("utf-8")

check("no byte is lost", len(text) == len(expected), "%d/%d chars" % (len(text), len(expected)))
check("content is byte-identical", text == expected, "first mismatch at %s" % next((index for index, (a, b) in enumerate(zip(text, expected)) if a != b), "none"))
check("no replacement characters", "\ufffd" not in text, repr(text[text.find("\ufffd") - 20:text.find("\ufffd") + 5]) if "\ufffd" in text else "")
check("read count equals the payload", pump.total_bytes == len(payload), "%d/%d bytes" % (pump.total_bytes, len(payload)))
check("frames are batched, not one per read", len(data_frames) < len(payload) // 37, "%d frames" % len(data_frames))

stats_frames = [frame for frame in frames if frame.get("type") == "stats"]
check("stats frames are emitted", len(stats_frames) >= 1, "%d frames" % len(stats_frames))
check("stats report the wire byte count", bool(stats_frames) and stats_frames[-1]["bytes"] == len(payload), str(stats_frames[-1:]))

print("\nALL PASS" if not failures else "\n%d FAILED" % len(failures))
sys.exit(0 if not failures else 1)
