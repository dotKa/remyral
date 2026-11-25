# Remyral code node runner (p14-workflow-engine 14.3, K3). Reads ONE JSON document {source, input} from stdin,
# runs `source` as the body of `def main(input, ctx):` and writes exactly one JSON line to stdout:
# {"ok":true,"output":...} or {"ok":false,"error":"..."}. print() of the user code goes to stderr, so stdout stays
# the protocol channel. Standard library only; no network, read-only root, no secrets.
import json
import os
import sys
import textwrap

_out = os.fdopen(os.dup(1), "w", encoding="utf-8")
sys.stdout = sys.stderr


def _emit(doc):
    _out.write(json.dumps(doc, ensure_ascii=False, allow_nan=False) + "\n")
    _out.flush()


try:
    doc = json.loads(sys.stdin.buffer.read().decode("utf-8"))
except Exception:
    _emit({"ok": False, "error": "runner: stdin is not one JSON document"})
    sys.exit(2)

try:
    body = textwrap.indent(str(doc.get("source", "")), "    ")
    scope = {"__name__": "remyral_code"}
    exec(compile("def main(input, ctx):\n" + body + "\n    return None\n", "<code>", "exec"), scope)
    value = scope["main"](doc.get("input"), {"language": "python"})
    try:
        text = json.dumps({"ok": True, "output": value}, ensure_ascii=False, allow_nan=False)
    except (TypeError, ValueError) as err:
        raise TypeError("the return value is not JSON-serialisable: %s" % err)
    _out.write(text + "\n")
    _out.flush()
    sys.exit(0)
except SystemExit:
    raise
except BaseException as err:
    _emit({"ok": False, "error": "%s: %s" % (type(err).__name__, err)})
    sys.exit(1)
