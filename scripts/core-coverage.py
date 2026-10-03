#!/usr/bin/env python3
"""Merge source-line evidence without treating unmeasured files as covered."""
import argparse
import json
import re
from pathlib import Path


def normalized(root, prefix, source):
    path = Path(source) if Path(source).is_absolute() else root / prefix / source
    try:
        return path.resolve().relative_to(root.resolve()).as_posix()
    except ValueError:
        return None


def collect(root, scope, lcov, python, go):
    lines = {}
    inputs = []
    conventions = []

    def merge(path, line, hit):
        if path in scope:
            item = lines.setdefault(path, {})
            item[line] = item.get(line, False) or hit

    for prefix, file in lcov:
        source = None
        for row in Path(file).read_text().splitlines():
            if row.startswith('SF:'):
                source = normalized(root, prefix, row[3:])
            elif source and row.startswith('DA:'):
                number, hits = row[3:].split(',')[:2]
                merge(source, int(number), int(hits) > 0)
        inputs.append({'format': 'lcov', 'prefix': prefix})
    for prefix, file in python:
        data = json.loads(Path(file).read_text())
        for source, counts in data['files'].items():
            path = normalized(root, prefix, source)
            missing = set(counts['missing_lines'])
            for line in set(counts['executed_lines']) | missing:
                merge(path, int(line), line not in missing)
        inputs.append({'format': 'coverage.py', 'prefix': prefix})
    for file in go:
        for row in Path(file).read_text().splitlines()[1:]:
            match = re.match(r'.*/sdks/go/(.*):(\d+)\.\d+,(\d+)\.\d+ \d+ (\d+)$', row)
            if not match:
                raise ValueError('Unexpected Go coverage record')
            source, start, end, hits = match.groups()
            for line in range(int(start), int(end) + 1):
                merge('sdks/go/' + source, line, int(hits) > 0)
        inputs.append({'format': 'go-coverprofile', 'prefix': 'sdks/go'})
        conventions.append('Go block ranges are mapped to source lines; this is an approximation, not a strict line instrumentation measure.')
    total = sum(len(value) for value in lines.values())
    covered = sum(sum(value.values()) for value in lines.values())
    missing = sorted(set(scope) - set(lines))
    return {'schema': 'anyroute.coverage/v1', 'scopeFiles': len(scope), 'measuredFiles': len(lines),
            'measuredLines': total, 'coveredMeasuredLines': covered,
            'measuredOnlyPercent': 100 * covered / total if total else 0,
            'complete': not missing and not conventions, 'unmeasuredSourceFiles': missing,
            'conventions': conventions, 'inputs': inputs,
            'files': {path: {'lines': len(value), 'covered': sum(value.values()),
                             'uncoveredLines': sorted(line for line, hit in value.items() if not hit)}
                      for path, value in sorted(lines.items())}}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--scope', required=True)
    parser.add_argument('--lcov', action='append', default=[], help='package-prefix:path (use . for root)')
    parser.add_argument('--python', action='append', default=[])
    parser.add_argument('--go', action='append', default=[])
    parser.add_argument('--minimum', type=float)
    parser.add_argument('--require-revision', help='Require every artifact to carry this exact CI source revision')
    args = parser.parse_args()
    if args.require_revision:
        if not re.fullmatch(r'[a-f0-9]{40}', args.require_revision):
            parser.error('Expected a 40-hex source revision')
        artifacts = [v.split(':', 1)[1] for v in args.lcov + args.python] + args.go
        for file in artifacts:
            if (Path(file).parent / 'source-revision.txt').read_text().strip() != args.require_revision:
                parser.error('Coverage artifacts belong to different source revisions')
            if (Path(file).parent / 'test-outcome.txt').read_text().strip() != 'success':
                parser.error('Coverage artifact came from an unsuccessful test run')
    scope = Path(args.scope).read_text().splitlines()
    result = collect(Path.cwd(), scope, [v.split(':', 1) for v in args.lcov],
                     [v.split(':', 1) for v in args.python], args.go)
    print(json.dumps(result, indent=2))
    if args.minimum is not None and (not result['complete'] or result['measuredOnlyPercent'] < args.minimum):
        raise SystemExit(1)


if __name__ == '__main__':
    main()
