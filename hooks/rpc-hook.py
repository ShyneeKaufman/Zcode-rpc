#!/usr/bin/env python3
"""Compatibility shim for hook runners that cached the pre-1.1 hooks.json
(which pointed at this .py file). Delegates to the Node hook and never
exits non-zero, so it can never block a tool call.

New sessions read hooks/hooks.json and invoke rpc-hook.mjs directly.
"""

import os
import shutil
import subprocess
import sys


def main() -> int:
    node = shutil.which("node")
    if not node:
        return 0
    script = os.path.join(os.path.dirname(os.path.abspath(__file__)), "rpc-hook.mjs")
    try:
        data = sys.stdin.buffer.read()
        proc = subprocess.run(
            [node, script],
            input=data,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=15,
        )
        if proc.stderr:
            sys.stderr.buffer.write(proc.stderr)
            sys.stderr.buffer.flush()
    except Exception:
        pass  # presence must never break a session
    return 0


if __name__ == "__main__":
    sys.exit(main())
