#!/usr/bin/env bash
# One-off listening demo for the "kenttäaudion normalisointi ja tuulenpoisto"
# idea logged in apps/broadcast/HANDOFF.md (2026-07-18). Builds several ffmpeg
# filter-chain variants from a real 4min sample clip and one narration-mix
# demo, so the results can be compared by ear before touching production code
# (ffmpegMixer.ts). Throwaway — not wired into any npm script or tsconfig.
#
# Source sample: public YouTube VOD (own club's camp match broadcast),
# https://www.youtube.com/live/nCbvAiof-Vc, seconds 800-1040 (~15min mark,
# chosen for wind gusts + player shouts). Re-fetch with:
#   yt-dlp --no-playlist -f "bestaudio/best" --download-sections "*800-1040" \
#     -o "raw.%(ext)s" "https://www.youtube.com/live/nCbvAiof-Vc"
# (run from run/field-audio-demo/source/, then re-run this script)
#
# Run: bash apps/broadcast/experiments/field-audio-demo.sh

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT_DIR="$HERE/../run/field-audio-demo"
SRC="$OUT_DIR/source/original.wav"
CLIPS="$OUT_DIR/clips"
REPORT="$OUT_DIR/measurements.txt"
VOICES_DIR="$HERE/../voices"
MODEL="$VOICES_DIR/fi_FI-harri-medium.onnx"

mkdir -p "$CLIPS"
: > "$REPORT"

measure() {
  local label="$1" file="$2"
  {
    echo "== $label =="
    ffmpeg -i "$file" -af volumedetect -f null - 2>&1 | grep -E "mean_volume|max_volume" || true
    ffmpeg -i "$file" -af loudnorm=print_format=json -f null - 2>&1 | sed -n '/^{/,/^}/p'
    echo
  } >> "$REPORT"
}

to_mp3() {
  ffmpeg -y -i "$1" -c:a libmp3lame -q:a 3 "$2" >/dev/null 2>&1
}

echo "1/8 baseline (untouched, just re-encoded)"
cp "$SRC" "$CLIPS/00-original.wav"
to_mp3 "$CLIPS/00-original.wav" "$CLIPS/00-original.mp3"
measure "00-original (untouched)" "$CLIPS/00-original.wav"

echo "2/8 highpass only (wind rumble)"
ffmpeg -y -i "$SRC" -af "highpass=f=120" "$CLIPS/01-highpass.wav" >/dev/null 2>&1
to_mp3 "$CLIPS/01-highpass.wav" "$CLIPS/01-highpass.mp3"
measure "01-highpass (f=120)" "$CLIPS/01-highpass.wav"

echo "3/8 highpass + dynaudnorm (level normalization)"
ffmpeg -y -i "$SRC" -af "highpass=f=120,dynaudnorm=f=500:g=15:p=0.9" "$CLIPS/02-highpass-dynaudnorm.wav" >/dev/null 2>&1
to_mp3 "$CLIPS/02-highpass-dynaudnorm.wav" "$CLIPS/02-highpass-dynaudnorm.mp3"
measure "02-highpass-dynaudnorm" "$CLIPS/02-highpass-dynaudnorm.wav"

echo "4/8 highpass + compressor/limiter (peak control for shouts)"
ffmpeg -y -i "$SRC" -af "highpass=f=120,acompressor=threshold=-18dB:ratio=4:attack=5:release=200,alimiter=limit=-1dB" "$CLIPS/03-highpass-complim.wav" >/dev/null 2>&1
to_mp3 "$CLIPS/03-highpass-complim.wav" "$CLIPS/03-highpass-complim.mp3"
measure "03-highpass-complim" "$CLIPS/03-highpass-complim.wav"

echo "5/8 highpass + afftdn (FFT denoiser, more aggressive)"
ffmpeg -y -i "$SRC" -af "highpass=f=120,afftdn=nr=12:nf=-25" "$CLIPS/04-highpass-afftdn.wav" >/dev/null 2>&1
to_mp3 "$CLIPS/04-highpass-afftdn.wav" "$CLIPS/04-highpass-afftdn.mp3"
measure "04-highpass-afftdn" "$CLIPS/04-highpass-afftdn.wav"

echo "6/8 combo (highpass + compressor + dynaudnorm + limiter — likely production candidate)"
ffmpeg -y -i "$SRC" -af "highpass=f=120,acompressor=threshold=-18dB:ratio=3:attack=10:release=250,dynaudnorm=f=500:g=10:p=0.9,alimiter=limit=-1dB" "$CLIPS/05-combo.wav" >/dev/null 2>&1
to_mp3 "$CLIPS/05-combo.wav" "$CLIPS/05-combo.mp3"
measure "05-combo" "$CLIPS/05-combo.wav"

echo "7/8 narration-mix demo: combo background + synthesized test line with sidechain ducking"
NARR_WAV="$CLIPS/_narration.wav"
piper --model "$MODEL" --output_file "$NARR_WAV" <<< "Testiselostus. Ysit vie pelin ratkaisuun, tilanne kolme kaksi." >/dev/null 2>&1
CLIP_DUR="$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$CLIPS/05-combo.wav")"
# sidechaincompress ends its output at the shorter of its two inputs, so the
# delayed narration trigger must be padded with silence out to the full clip
# length first (asplit duplicates it: one copy drives the sidechain, one copy
# gets mixed in) — otherwise the whole output truncates to ~35s (narration
# delay + narration length).
ffmpeg -y -i "$CLIPS/05-combo.wav" -i "$NARR_WAV" -filter_complex \
  "[1:a]adelay=30000|30000,volume=1.3,apad=whole_dur=${CLIP_DUR},asplit=2[narrsc][narrmix]; \
   [0:a][narrsc]sidechaincompress=threshold=0.05:ratio=8:attack=5:release=300[bgducked]; \
   [bgducked][narrmix]amix=inputs=2:duration=first:normalize=0,alimiter=limit=-1dB[out]" \
  -map "[out]" -t "$CLIP_DUR" "$CLIPS/06-combo-narration-ducked.wav" >/dev/null 2>&1
to_mp3 "$CLIPS/06-combo-narration-ducked.wav" "$CLIPS/06-combo-narration-ducked.mp3"
measure "06-combo-narration-ducked" "$CLIPS/06-combo-narration-ducked.wav"

echo "8/8 same narration mix WITHOUT ducking (for comparison — narration just added on top)"
ffmpeg -y -i "$CLIPS/05-combo.wav" -i "$NARR_WAV" -filter_complex \
  "[1:a]adelay=30000|30000,volume=1.3[narr]; \
   [0:a][narr]amix=inputs=2:duration=first:normalize=0,alimiter=limit=-1dB[out]" \
  -map "[out]" -t "$CLIP_DUR" "$CLIPS/07-combo-narration-noduck.wav" >/dev/null 2>&1
to_mp3 "$CLIPS/07-combo-narration-noduck.wav" "$CLIPS/07-combo-narration-noduck.mp3"
measure "07-combo-narration-noduck" "$CLIPS/07-combo-narration-noduck.wav"

# Drop intermediate WAVs and the narration scratch file — mp3s are what get listened to.
rm -f "$CLIPS"/*.wav

echo
echo "Done. mp3s in $CLIPS"
echo "Measurements in $REPORT"
