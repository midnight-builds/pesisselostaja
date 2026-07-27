#!/usr/bin/env bash
# v2 of the field-audio (kenttäaudio) demo — full 19min clip this time, and a
# filter set explicitly designed against apps/broadcast/experiments/
# field-audio-criteria.md, in particular criterion 4 (don't flatten the
# game's dynamics into a monotonous mix). v1 (short 4min excerpt, aggressive
# combo) is superseded but left in place for reference.
#
# Source: full audio track of https://www.youtube.com/live/nCbvAiof-Vc
# (own club's camp match VOD), re-fetch with:
#   yt-dlp --no-playlist -f "bestaudio/best" -o "raw_full.%(ext)s" \
#     "https://www.youtube.com/live/nCbvAiof-Vc"
#   ffmpeg -y -i raw_full.webm -ac 2 -ar 48000 -c:a pcm_s16le original_full.wav
# (run from run/field-audio-demo/source/)
#
# Run: bash apps/broadcast/experiments/field-audio-demo-v2.sh

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT_DIR="$HERE/../run/field-audio-demo"
SRC="$OUT_DIR/source/original_full.wav"
CLIPS="$OUT_DIR/clips-v2"
REPORT="$OUT_DIR/measurements-v2.txt"
VOICES_DIR="$HERE/../voices"
MODEL="$VOICES_DIR/fi_FI-harri-medium.onnx"
PARSE="$HERE/parse_ebur128.py"

# Landmark timestamps found by analysing the original (see field-audio-criteria.md)
WINDY_START=1020   # ~17:00, windiest 15s window centered near 17:15
LOUD_T=1040         # loudest instant, ~17:20
CALM_T=520           # calm stable stretch, ~8:47

mkdir -p "$CLIPS"
: > "$REPORT"

measure() {
  local label="$1" file="$2"
  {
    echo "== $label =="
    ffmpeg -i "$file" -af loudnorm=print_format=json -f null - 2>&1 | sed -n '/^{/,/^}/p'
    echo "-- low-band (<150Hz) energy at windiest window (${WINDY_START}s, 15s) --"
    ffmpeg -ss "$WINDY_START" -t 15 -i "$file" -af "lowpass=f=150,volumedetect" -f null - 2>&1 | grep -E "mean_volume|max_volume"
    echo "-- momentary-loudness dynamics (whole clip) --"
    ffmpeg -v verbose -i "$file" -filter_complex ebur128=framelog=verbose:peak=true -f null - 2>"$OUT_DIR/_tmp_ebur.log" || true
    python3 "$PARSE" "$OUT_DIR/_tmp_ebur.log"
    echo
  } >> "$REPORT"
}

to_mp3() {
  ffmpeg -y -i "$1" -c:a libmp3lame -q:a 3 "$2" >/dev/null 2>&1
}

# 15s snippet around a landmark, for the narrower single-question comparisons
# (cutoff frequency, denoiser aggressiveness) where full 19min isn't needed.
snippet() {
  local src="$1" center="$2" out="$3"
  local start=$(( center > 10 ? center - 10 : 0 ))
  ffmpeg -y -ss "$start" -t 20 -i "$src" -c:a libmp3lame -q:a 3 "$out" >/dev/null 2>&1
}

echo "[1/12] 00-original (untouched, full length)"
to_mp3 "$SRC" "$CLIPS/00-original.mp3"
measure "00-original" "$SRC"

echo "[2/12] 01a-highpass100 (windy-snippet only — cutoff comparison)"
ffmpeg -y -i "$SRC" -af "highpass=f=100" "$CLIPS/_hp100.wav" >/dev/null 2>&1
snippet "$CLIPS/_hp100.wav" "$WINDY_START" "$CLIPS/01a-highpass100-snippet.mp3"

echo "[3/12] 01b-highpass150 (windy-snippet only — cutoff comparison)"
ffmpeg -y -i "$SRC" -af "highpass=f=150" "$CLIPS/_hp150.wav" >/dev/null 2>&1
snippet "$CLIPS/_hp150.wav" "$WINDY_START" "$CLIPS/01b-highpass150-snippet.mp3"

# highpass=120 as the settled middle ground used by every full-length variant below.
HP="highpass=f=120"

echo "[4/12] 01-highpass (full length, f=120 — the 'just remove wind, touch nothing else' baseline)"
ffmpeg -y -i "$SRC" -af "$HP" "$CLIPS/_01.wav" >/dev/null 2>&1
to_mp3 "$CLIPS/_01.wav" "$CLIPS/01-highpass.mp3"
measure "01-highpass (f=120)" "$CLIPS/_01.wav"

echo "[5/12] 02-peaklimiter (full length — ONLY stops digital overs, zero leveling, dynamics 100% intact otherwise)"
ffmpeg -y -i "$SRC" -af "$HP,alimiter=limit=0.891:attack=5:release=50:level=disabled:asc=disabled" "$CLIPS/_02.wav" >/dev/null 2>&1
to_mp3 "$CLIPS/_02.wav" "$CLIPS/02-peaklimiter.mp3"
measure "02-peaklimiter" "$CLIPS/_02.wav"

echo "[6/12] 03-gentle-dynaudnorm (full length — slow 2s window, capped gain, preserves cheers/quiet swings)"
ffmpeg -y -i "$SRC" -af "$HP,dynaudnorm=f=2000:g=63:m=4:p=0.95,alimiter=limit=0.891:level=disabled" "$CLIPS/_03.wav" >/dev/null 2>&1
to_mp3 "$CLIPS/_03.wav" "$CLIPS/03-gentle-dynaudnorm.mp3"
measure "03-gentle-dynaudnorm" "$CLIPS/_03.wav"

echo "[7/12] 04-gentle-compressor (full length — slow 2:1 compressor instead of dynaudnorm, alternative leveling approach)"
ffmpeg -y -i "$SRC" -af "$HP,acompressor=threshold=-24dB:ratio=2:attack=30:release=600:knee=6:makeup=3dB,alimiter=limit=0.891:level=disabled" "$CLIPS/_04.wav" >/dev/null 2>&1
to_mp3 "$CLIPS/_04.wav" "$CLIPS/04-gentle-compressor.mp3"
measure "04-gentle-compressor" "$CLIPS/_04.wav"

echo "[8/12] 05-moderate-combo (full length — RECOMMENDED candidate: balance of leveling + preserved dynamics)"
ffmpeg -y -i "$SRC" -af "$HP,acompressor=threshold=-20dB:ratio=2.5:attack=15:release=400:knee=6,dynaudnorm=f=1000:g=45:m=6:p=0.95,alimiter=limit=0.891:level=disabled" "$CLIPS/_05.wav" >/dev/null 2>&1
to_mp3 "$CLIPS/_05.wav" "$CLIPS/05-moderate-combo.mp3"
measure "05-moderate-combo (RECOMMENDED candidate)" "$CLIPS/_05.wav"

echo "[9/12] 06-aggressive-reference (full length — v1's old combo, kept as a deliberate NEGATIVE example: this is what 'too flat' sounds like)"
ffmpeg -y -i "$SRC" -af "$HP,acompressor=threshold=-18dB:ratio=4:attack=5:release=200,dynaudnorm=f=500:g=15:m=10:p=0.9,alimiter=limit=0.891" "$CLIPS/_06.wav" >/dev/null 2>&1
to_mp3 "$CLIPS/_06.wav" "$CLIPS/06-aggressive-reference.mp3"
measure "06-aggressive-reference (NEGATIVE example — expect flattened dynamics)" "$CLIPS/_06.wav"

echo "[10/12] 07a/07b afftdn light vs heavy (calm-moment snippet only — where denoiser artifacts are most audible)"
ffmpeg -y -i "$SRC" -af "$HP,afftdn=nr=6:nf=-30" "$CLIPS/_07a.wav" >/dev/null 2>&1
snippet "$CLIPS/_07a.wav" "$CALM_T" "$CLIPS/07a-afftdn-light-snippet.mp3"
ffmpeg -y -i "$SRC" -af "$HP,afftdn=nr=12:nf=-25" "$CLIPS/_07b.wav" >/dev/null 2>&1
snippet "$CLIPS/_07b.wav" "$CALM_T" "$CLIPS/07b-afftdn-heavy-snippet.mp3"

echo "[11/13] 08/09 narration-mix demo built on 05-moderate-combo (early guess before measurements came in — kept only for comparison, see demo.md for why 03 won instead)"
NARR_WAV="$CLIPS/_narration.wav"
piper --model "$MODEL" --output_file "$NARR_WAV" <<< "Testiselostus. Ysit vie pelin ratkaisuun, tilanne kolme kaksi." >/dev/null 2>&1
CLIP_DUR="$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$CLIPS/_05.wav")"
ffmpeg -y -i "$CLIPS/_05.wav" -i "$NARR_WAV" -filter_complex \
  "[1:a]adelay=${LOUD_T}000|${LOUD_T}000,volume=1.3,apad=whole_dur=${CLIP_DUR},asplit=2[narrsc][narrmix]; \
   [0:a][narrsc]sidechaincompress=threshold=0.05:ratio=8:attack=5:release=300[bgducked]; \
   [bgducked][narrmix]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.891[out]" \
  -map "[out]" -t "$CLIP_DUR" "$CLIPS/_08.wav" >/dev/null 2>&1
to_mp3 "$CLIPS/_08.wav" "$CLIPS/08-recommended-narration-ducked.mp3"

ffmpeg -y -i "$CLIPS/_05.wav" -i "$NARR_WAV" -filter_complex \
  "[1:a]adelay=${LOUD_T}000|${LOUD_T}000,volume=1.3[narr]; \
   [0:a][narr]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.891[out]" \
  -map "[out]" -t "$CLIP_DUR" "$CLIPS/_09.wav" >/dev/null 2>&1
to_mp3 "$CLIPS/_09.wav" "$CLIPS/09-recommended-narration-noduck.mp3"

echo "[12/13] 10/11 narration-mix demo rebuilt on 03-gentle-dynaudnorm — the actual data-backed leading candidate"
ffmpeg -y -i "$SRC" -af "$HP,dynaudnorm=f=2000:g=63:m=4:p=0.95,alimiter=limit=0.891:level=disabled" "$CLIPS/_03b.wav" >/dev/null 2>&1
CLIP_DUR_03="$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$CLIPS/_03b.wav")"
ffmpeg -y -i "$CLIPS/_03b.wav" -i "$NARR_WAV" -filter_complex \
  "[1:a]adelay=${LOUD_T}000|${LOUD_T}000,volume=1.3,apad=whole_dur=${CLIP_DUR_03},asplit=2[narrsc][narrmix]; \
   [0:a][narrsc]sidechaincompress=threshold=0.05:ratio=8:attack=5:release=300[bgducked]; \
   [bgducked][narrmix]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.891[out]" \
  -map "[out]" -t "$CLIP_DUR_03" "$CLIPS/_10.wav" >/dev/null 2>&1
to_mp3 "$CLIPS/_10.wav" "$CLIPS/10-gentle-dynaudnorm-narration-ducked.mp3"

ffmpeg -y -i "$CLIPS/_03b.wav" -i "$NARR_WAV" -filter_complex \
  "[1:a]adelay=${LOUD_T}000|${LOUD_T}000,volume=1.3[narr]; \
   [0:a][narr]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.891[out]" \
  -map "[out]" -t "$CLIP_DUR_03" "$CLIPS/_11.wav" >/dev/null 2>&1
to_mp3 "$CLIPS/_11.wav" "$CLIPS/11-gentle-dynaudnorm-narration-noduck.mp3"

echo "[13/13] cleanup intermediates"
rm -f "$CLIPS"/_*.wav "$OUT_DIR/_tmp_ebur.log"

echo
echo "Done. mp3s in $CLIPS"
echo "Measurements in $REPORT"
