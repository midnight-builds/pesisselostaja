#!/usr/bin/env python3
"""Deterministic "EI SIGNAALIA" slate composer (issue #104).

Renders the static background the relay pushes to RTMP while the video feed is
down (`ffmpeg -loop 1 -i slate.png`). 1920x1080 by default, fixed layout:
- 7 classic colour bars at 75% brightness, 58% of the frame height
- narrow black separator band under the bars, black below that
- headline "EI SIGNAALIA", 118 px bold, white
- an empty score line (live)
- an empty status line (live)
- footer "Pesisselostaja", 32 px, dark grey

Why the background and the two live lines are separated
-------------------------------------------------------
ffmpeg reads the PNG **once** when `-loop 1 -i slate.png` starts, so replacing
the file on disk would require respawning the input = a visible gap in the
broadcast. Therefore only the parts that never change during an outage are
baked into the PNG. The two lines that do change (score, status) are drawn by
ffmpeg's `drawtext` filter with `textfile=...:reload=1`, which re-reads the
text file every frame - the relay just rewrites the file and the picture
updates without a respawn.

This script therefore has two jobs:
1. render the static background, and
2. print the layout geometry (as one line of JSON on stdout) so the TypeScript
   side knows where to put those two drawtext lines instead of guessing. The
   JSON values are computed by the same layout code that draws the image, so
   they stay in sync when --width/--height change.

Layout decided in the comment thread of issue #104 (29.7.2026), user-approved
"vaihtoehto A".

Usage:
  # production background (both live lines left empty)
  python3 no-signal-slate.py --out slate.png

  # preview with the live lines baked in, for eyeballing the composition only
  python3 no-signal-slate.py --out preview.png \
    --score "Kotipesä 12 - 1 Lyöntilä" \
    --status "1. jakso, 2 paloa — kuvayhteys katkesi, selostus jatkuu"

stdout is ONE line of JSON and nothing else; errors go to stderr with a
non-zero exit code.

Note on `size`: the JSON reports the nominal font size for each live line plus
the `maxWidth` the text has to fit into. If a preview string is wider than
`maxWidth` this script shrinks that one line to fit (the reported `y` never
moves); the relay should apply the same shrink rule to its drawtext fontsize.
"""

import argparse
import json
import os
import sys

from PIL import Image, ImageDraw, ImageFont

FONT_BOLD = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
FONT_REGULAR = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"

# Reference design size; every px value below is expressed for this frame and
# scaled by height/width when --width/--height differ.
REF_W, REF_H = 1920, 1080

BARS_FRACTION = 0.58        # colour bars height as a fraction of frame height
SEPARATOR_FRACTION = 0.02   # narrow black band between bars and the text block
SIDE_MARGIN_FRACTION = 0.06 # horizontal safe margin for all text

# Classic colour-bar order, left to right, at 75% brightness (191, not 255).
BAR_LEVEL = 191
BAR_COLORS = [
    (BAR_LEVEL, BAR_LEVEL, BAR_LEVEL),  # white
    (BAR_LEVEL, BAR_LEVEL, 0),          # yellow
    (0, BAR_LEVEL, BAR_LEVEL),          # cyan
    (0, BAR_LEVEL, 0),                  # green
    (BAR_LEVEL, 0, BAR_LEVEL),          # magenta
    (BAR_LEVEL, 0, 0),                  # red
    (0, 0, BAR_LEVEL),                  # blue
]

# Text block, top to bottom: (nominal size at REF_H, gap below the line).
HEADLINE_SIZE, HEADLINE_GAP = 118, 26
SCORE_SIZE, SCORE_GAP = 58, 22
STATUS_SIZE, STATUS_GAP = 42, 42
FOOTER_SIZE = 32

COLOR_WHITE = (255, 255, 255)
COLOR_STATUS = (0xB0, 0xB0, 0xB0)
COLOR_FOOTER = (0x6E, 0x6E, 0x6E)


def find_font(paths, size):
    for p in paths:
        try:
            return ImageFont.truetype(p, size=size)
        except Exception:
            pass
    return ImageFont.load_default()


def rgb_to_ffmpeg(rgb):
    """ffmpeg-compatible colour string for drawtext."""
    if rgb == (255, 255, 255):
        return "white"
    return "0x%02X%02X%02X" % rgb


def compute_layout(width, height):
    """Single source of truth for the composition.

    Returns a dict with pixel geometry; both the renderer and the JSON emitted
    on stdout are derived from it, so they can never drift apart.
    """
    scale = height / REF_H

    def s(v):
        return max(1, round(v * scale))

    bars_height = round(height * BARS_FRACTION)
    separator_height = round(height * SEPARATOR_FRACTION)
    side_margin = round(width * SIDE_MARGIN_FRACTION)
    max_text_width = width - 2 * side_margin

    headline = s(HEADLINE_SIZE)
    score = s(SCORE_SIZE)
    status = s(STATUS_SIZE)
    footer = s(FOOTER_SIZE)
    gap_headline = s(HEADLINE_GAP)
    gap_score = s(SCORE_GAP)
    gap_status = s(STATUS_GAP)

    # Vertically centre the four-line block in the black area below the bars,
    # so the composition stays balanced at other frame sizes.
    block_top = bars_height + separator_height
    block_height = (
        headline + gap_headline + score + gap_score + status + gap_status + footer
    )
    y = block_top + max(0, round((height - block_top - block_height) / 2))

    headline_y = y
    y += headline + gap_headline
    score_y = y
    y += score + gap_score
    status_y = y
    y += status + gap_status
    footer_y = y

    return {
        "width": width,
        "height": height,
        "barsHeight": bars_height,
        "separatorHeight": separator_height,
        "sideMargin": side_margin,
        "maxTextWidth": max_text_width,
        "headline": {"y": headline_y, "size": headline, "color": COLOR_WHITE, "bold": True},
        "score": {"y": score_y, "size": score, "color": COLOR_WHITE, "bold": True},
        "status": {"y": status_y, "size": status, "color": COLOR_STATUS, "bold": False},
        "footer": {"y": footer_y, "size": footer, "color": COLOR_FOOTER, "bold": False},
    }


def layout_json(layout):
    """The subset of the layout the TypeScript relay needs for drawtext."""
    return {
        "width": layout["width"],
        "height": layout["height"],
        "barsHeight": layout["barsHeight"],
        "fontBold": FONT_BOLD,
        "fontRegular": FONT_REGULAR,
        "score": {
            "y": layout["score"]["y"],
            "size": layout["score"]["size"],
            "color": rgb_to_ffmpeg(layout["score"]["color"]),
            "maxWidth": layout["maxTextWidth"],
        },
        "status": {
            "y": layout["status"]["y"],
            "size": layout["status"]["size"],
            "color": rgb_to_ffmpeg(layout["status"]["color"]),
            "maxWidth": layout["maxTextWidth"],
        },
    }


def draw_bars(draw, width, bars_height):
    n = len(BAR_COLORS)
    for i, color in enumerate(BAR_COLORS):
        # Integer boundaries from the same formula -> no rounding gap on the
        # right edge and no seams between bars.
        x1 = round(width * i / n)
        x2 = round(width * (i + 1) / n)
        draw.rectangle([x1, 0, x2 - 1, bars_height - 1], fill=color)


def draw_centered(draw, width, spec, text, max_width):
    """Draw `text` centred, with the box top exactly at spec['y'].

    Shrinks the font (never the y) if the string is too wide for the safe area.
    """
    if not text:
        return
    path = FONT_BOLD if spec["bold"] else FONT_REGULAR
    size = spec["size"]
    font = find_font([path], size)
    while size > 12 and draw.textlength(text, font=font) > max_width:
        size -= 1
        font = find_font([path], size)
    tw = draw.textlength(text, font=font)
    draw.text(((width - tw) / 2, spec["y"]), text, font=font, fill=spec["color"])


def main():
    ap = argparse.ArgumentParser(
        description='Render the "EI SIGNAALIA" slate background and print its layout as JSON.'
    )
    ap.add_argument("--out", required=True, help="Output PNG path.")
    ap.add_argument("--width", type=int, default=REF_W)
    ap.add_argument("--height", type=int, default=REF_H)
    ap.add_argument("--headline", default="EI SIGNAALIA")
    ap.add_argument("--footer", default="Pesisselostaja")
    ap.add_argument(
        "--score",
        default="",
        help="PREVIEW ONLY: bake the score line into the PNG. Production leaves it empty "
             "(the relay draws it with drawtext).",
    )
    ap.add_argument(
        "--status",
        default="",
        help="PREVIEW ONLY: bake the status line into the PNG. Production leaves it empty.",
    )
    args = ap.parse_args()

    if args.width < 320 or args.height < 240:
        raise ValueError("--width/--height too small (min 320x240)")

    layout = compute_layout(args.width, args.height)

    base = Image.new("RGB", (args.width, args.height), (0, 0, 0))
    draw = ImageDraw.Draw(base)

    draw_bars(draw, args.width, layout["barsHeight"])
    # Separator band + the rest of the frame are already black from the fill;
    # the band exists as layout space between the bars and the headline.

    max_width = layout["maxTextWidth"]
    draw_centered(draw, args.width, layout["headline"], args.headline, max_width)
    draw_centered(draw, args.width, layout["score"], args.score, max_width)
    draw_centered(draw, args.width, layout["status"], args.status, max_width)
    draw_centered(draw, args.width, layout["footer"], args.footer, max_width)

    out_dir = os.path.dirname(os.path.abspath(args.out))
    if out_dir:
        os.makedirs(out_dir, exist_ok=True)
    base.save(args.out, "PNG", optimize=True)

    sys.stdout.write(json.dumps(layout_json(layout), separators=(",", ":")) + "\n")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:  # noqa: BLE001 - CLI boundary
        sys.stderr.write("no-signal-slate: %s\n" % exc)
        sys.exit(1)
