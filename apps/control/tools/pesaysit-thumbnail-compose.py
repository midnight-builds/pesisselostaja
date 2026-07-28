#!/usr/bin/env python3
"""Deterministic thumbnail composer.

Takes a background image (any aspect) and outputs a 1280x720 thumbnail with fixed layout:
- Solid safe margins
- LIVE badge top-right
- Headline (2 lines max)
- Date/time line
- Venue line
- No generated center icon by default. Background/template must provide its own visual identity.

Usage:
  python3 pesaysit-thumbnail-compose.py --bg in.png --out out.png \
    --headline "Pesä Ysit G - SuPo G mustat" \
    --datetime "21.3.2026 klo 10:00" \
    --venue "Kotka Ruonalan urheiluhalli"
    [--left-badge-text "Selostettu tekoälyllä"]

"""

import argparse
from PIL import Image, ImageDraw, ImageFont, ImageOps

W, H = 1280, 720


def find_font(paths, size):
    for p in paths:
        try:
            return ImageFont.truetype(p, size=size)
        except Exception:
            pass
    return ImageFont.load_default()


def wrap_two_lines(draw, text, font, max_width):
    # Respect an explicit line break when provided.
    if "\n" in text:
        lines = [part.strip() for part in text.splitlines() if part.strip()]
        if len(lines) <= 2 and all(draw.textlength(line, font=font) <= max_width for line in lines):
            return lines

    # Simple greedy wrap to <=2 lines.
    words = text.split()
    if not words:
        return [""]

    lines = []
    cur = ""
    for w in words:
        candidate = (cur + " " + w).strip()
        if draw.textlength(candidate, font=font) <= max_width:
            cur = candidate
        else:
            if cur:
                lines.append(cur)
            cur = w
    if cur:
        lines.append(cur)

    if len(lines) <= 2:
        return lines

    # If >2, merge tail into 2nd and truncate
    first = lines[0]
    second = " ".join(lines[1:])
    while draw.textlength(second + "…", font=font) > max_width and len(second) > 0:
        second = second[:-1].rstrip()
    return [first, (second + "…") if second else "…"]


def draw_badge(im, x, y, text="LIVE", align="right"):
    draw = ImageDraw.Draw(im)
    font = find_font([
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    ], 40)
    text_w = draw.textlength(text, font=font)
    pad_x = 24
    badge_w = max(150, int(text_w + pad_x * 2))
    badge_h = 64
    x1 = x if align == "left" else x - badge_w
    y1 = y
    radius = 14
    x2 = x1 + badge_w
    draw.rounded_rectangle([x1, y1, x2, y1 + badge_h], radius=radius, fill=(0, 0, 0))
    tx = x1 + (badge_w - text_w) / 2
    ty = y1 + 10
    draw.text((tx, ty), text, font=font, fill=(255, 255, 255))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--bg', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--headline', required=True)
    ap.add_argument('--datetime', required=True)
    ap.add_argument('--venue', required=True)

    ap.add_argument('--no-live-badge', action='store_true', help='Do not draw the LIVE badge (use when bg already contains it).')
    ap.add_argument('--live-shift-pct', type=float, default=0.0, help='Move LIVE badge left by this fraction of width (e.g. 0.05 = 5%%).')
    ap.add_argument('--left-badge-text', default='', help='Optional top-left badge text, styled like the LIVE badge.')
    ap.add_argument('--stroke-width', type=int, default=2, help='Text outline (stroke) width in pixels.')
    ap.add_argument('--stroke-gray', type=int, default=70, help='Stroke color as gray 0-255 (default: 70).')
    ap.add_argument('--shadow-dx', type=int, default=0, help='Text drop-shadow offset X in px (0 disables shadow).')
    ap.add_argument('--shadow-dy', type=int, default=0, help='Text drop-shadow offset Y in px (0 disables shadow).')
    ap.add_argument('--shadow-gray', type=int, default=0, help='Shadow color as gray 0-255 (default: 0 black).')
    ap.add_argument('--shadow-strength', type=int, default=1, help='Shadow strength by drawing it N times (>=1).')

    args = ap.parse_args()

    bg = Image.open(args.bg).convert('RGB')
    base = ImageOps.fit(bg, (W, H), method=Image.Resampling.LANCZOS, centering=(0.5, 0.5))

    margin = 90
    draw = ImageDraw.Draw(base)

    headline_font = find_font([
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    ], 86)
    sub_font = find_font([
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    ], 46)

    if not args.no_live_badge:
        live_x2 = W - margin - int(W * max(0.0, args.live_shift_pct))
        draw_badge(base, live_x2, margin - 15)
    if args.left_badge_text:
        draw_badge(base, margin, margin - 15, text=args.left_badge_text, align="left")

    max_text_w = W - 2 * margin
    lines = wrap_two_lines(draw, args.headline, headline_font, max_text_w)
    stroke_fill = (args.stroke_gray, args.stroke_gray, args.stroke_gray)
    shadow_fill = (args.shadow_gray, args.shadow_gray, args.shadow_gray)

    def draw_text_with_effects(x, y, text, font):
        # Shadow (optional)
        if (args.shadow_dx != 0 or args.shadow_dy != 0) and args.shadow_strength > 0:
            for _ in range(max(1, args.shadow_strength)):
                draw.text(
                    (x + args.shadow_dx, y + args.shadow_dy),
                    text,
                    font=font,
                    fill=shadow_fill,
                )
        # Main text with stroke
        draw.text(
            (x, y),
            text,
            font=font,
            fill=(255, 255, 255),
            stroke_width=max(0, args.stroke_width),
            stroke_fill=stroke_fill,
        )

    y = 330
    for line in lines:
        tw = draw.textlength(line, font=headline_font)
        x = (W - tw) / 2
        draw_text_with_effects(x, y, line, headline_font)
        y += 92

    for txt in (args.datetime, args.venue):
        tw = draw.textlength(txt, font=sub_font)
        x = (W - tw) / 2
        draw_text_with_effects(x, y, txt, sub_font)
        y += 56

    base.save(args.out, 'PNG', optimize=True)


if __name__ == '__main__':
    main()
