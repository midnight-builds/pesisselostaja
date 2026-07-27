#!/usr/bin/env python3
"""Parse ffmpeg ebur128 verbose frame log into momentary-loudness stats.
Throwaway analysis helper for field-audio-demo — not part of any app."""
import re
import sys
import statistics

pat = re.compile(
    r"t:\s*([\d.]+)\s+TARGET:.*?M:\s*(-?[\d.]+|-inf)\s+S:\s*(-?[\d.]+|-inf)"
)


def to_float(s):
    if s == "-inf":
        return -120.0
    return float(s)


def main(path):
    times, mvals = [], []
    with open(path) as f:
        for line in f:
            m = pat.search(line)
            if not m:
                continue
            t = float(m.group(1))
            mv = to_float(m.group(2))
            times.append(t)
            mvals.append(mv)

    # Drop the startup ramp (< 1s) where the 400ms window isn't full yet.
    pairs = [(t, v) for t, v in zip(times, mvals) if t >= 1.0 and v > -110]
    vals = [v for _, v in pairs]
    vals_sorted = sorted(vals)

    def pct(p):
        idx = min(len(vals_sorted) - 1, int(len(vals_sorted) * p))
        return vals_sorted[idx]

    mean = statistics.mean(vals)
    stdev = statistics.pstdev(vals)
    p10, p50, p90 = pct(0.10), pct(0.50), pct(0.90)

    loudest_t, loudest_v = max(pairs, key=lambda p: p[1])
    # Quietest "stable" moment: look for a 5s window (50 samples @100ms) with
    # low mean and low internal variance (i.e. calm ambient, not a dropout).
    window = 50
    best = None
    for i in range(0, len(pairs) - window, 10):
        chunk = [v for _, v in pairs[i : i + window]]
        cm = statistics.mean(chunk)
        cs = statistics.pstdev(chunk)
        score = cm + cs * 2  # prefer low mean AND low variance
        if best is None or score < best[0]:
            best = (score, pairs[i][0], cm)

    print(f"n_samples={len(vals)}")
    print(f"mean_M={mean:.1f} LUFS  stdev_M={stdev:.2f} LU")
    print(f"p10={p10:.1f}  p50={p50:.1f}  p90={p90:.1f}  spread(p90-p10)={p90-p10:.2f} LU")
    print(f"loudest_moment: t={loudest_t:.1f}s ({int(loudest_t//60)}:{loudest_t%60:04.1f}) M={loudest_v:.1f} LUFS")
    print(f"calm_moment: t={best[1]:.1f}s ({int(best[1]//60)}:{best[1]%60:04.1f}) mean_M~{best[2]:.1f} LUFS")


if __name__ == "__main__":
    main(sys.argv[1])
