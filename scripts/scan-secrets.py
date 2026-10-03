#!/usr/bin/env python3
"""Run Gitleaks without persisting secrets or author metadata.

History exceptions identify immutable commits. Working-tree exceptions bind the
exact reviewed source span, so replacing a fixture with a real key fails the gate.
"""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import sys


def approved_tree(finding, exceptions, root):
    relative = finding.get("File", "")
    path = (root / relative).resolve()
    if not path.is_relative_to(root) or not path.is_file():
        return False
    start, end = finding.get("StartLine", 0), finding.get("EndLine", 0)
    if not isinstance(start, int) or not isinstance(end, int) or not 0 < start <= end:
        return False
    lines = path.read_bytes().splitlines(keepends=True)
    if end > len(lines):
        return False
    digest = hashlib.sha256(b"".join(lines[start - 1:end])).hexdigest()
    return any(x["file"] == relative and x["rule"] == finding.get("RuleID")
               and x["start"] == start and x["end"] == end and x["sha256"] == digest
               for x in exceptions)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--gitleaks", default="gitleaks")
    parser.add_argument("--output", default="release-evidence/secrets.json")
    args = parser.parse_args()
    root = Path(__file__).resolve().parent.parent
    baseline = json.loads((root / "security/secret-fixtures.json").read_text())
    findings = []
    for mode in ("git", "dir"):
        result = subprocess.run([args.gitleaks, mode, "--redact", "--no-banner", "--log-level", "error",
                                 "--report-format", "json", "--report-path", "/dev/stdout"],
                                cwd=root, capture_output=True, text=True)
        if result.returncode not in (0, 1):
            # Do not expose exception/output text that may contain a credential.
            print(f"Gitleaks {mode} failed with exit {result.returncode}", file=sys.stderr)
            return 2
        try:
            rows = json.loads(result.stdout or "[]")
            if not isinstance(rows, list):
                raise ValueError("invalid result")
        except (ValueError, TypeError):
            print("Gitleaks produced invalid JSON", file=sys.stderr)
            return 2
        for row in rows:
            allowed = (row.get("Fingerprint") in baseline["history"] if mode == "git"
                       else approved_tree(row, baseline["tree"], root))
            if not allowed:
                findings.append({"mode": mode, "rule": row.get("RuleID"), "file": row.get("File"),
                                 "start": row.get("StartLine"), "end": row.get("EndLine")})
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps({"ok": not findings, "findings": findings}, indent=2) + "\n")
    print(f"Secret gate: {len(findings)} unapproved findings; values and identities omitted")
    return 1 if findings else 0


if __name__ == "__main__":
    sys.exit(main())
