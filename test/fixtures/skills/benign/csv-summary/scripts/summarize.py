import csv
import statistics
import sys

with open(sys.argv[1], newline="") as handle:
    rows = list(csv.DictReader(handle))
print(f"rows: {len(rows)}")
for column in rows[0].keys() if rows else []:
    values = []
    for row in rows:
        try:
            values.append(float(row[column]))
        except (TypeError, ValueError):
            pass
    if values:
        print(f"{column}: mean={statistics.mean(values):.3f} min={min(values)} max={max(values)}")
