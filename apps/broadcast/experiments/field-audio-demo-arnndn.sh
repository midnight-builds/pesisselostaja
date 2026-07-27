#!/usr/bin/env bash
# RNNoise (arnndn) follow-up to field-audio-demo-v2.sh — tests the neural
# denoiser the criteria doc flagged as "not done, ask before fetching a
# model". User asked to fetch it and test. Models pulled from the
# community-maintained https://github.com/GregorR/rnnoise-models (linked
# from ffmpeg's own arnndn docs/wiki), stored in
# run/field-audio-demo/rnnoise-models/ (gitignored, re-fetch with the
# curl commands in field-audio-demo.md).
#
# Three models tested, per the repo's own signal/noise matrix (README.md):
#   marathon-prescription : general signal (voice+laughs+music) vs general noise — best fit guess
#   conjoined-burgers      : general signal vs "recording" (fan/AC/device) noise
#   beguiling-drafter      : VOICE-ONLY signal vs recording noise — deliberately the
#                            "wrong tool" example (trained to treat non-speech, i.e.
#                            crowd ambience, as noise to remove)
# Plus one variant combining the best denoiser with the existing recommended
# 03-gentle-dynaudnorm chain, to answer "should arnndn be ADDED to what we
# already picked".
#
# Run: bash apps/broadcast/experiments/field-audio-demo-arnndn.sh

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT_DIR="$HERE/../run/field-audio-demo"
SRC="$OUT_DIR/source/original_full.wav"
MODELS="$OUT_DIR/rnnoise-models"
CLIPS="$OUT_DIR/clips-v2"
REPORT="$OUT_DIR/measurements-arnndn.txt"
PARSE="$HERE/parse_ebur128.py"

WINDY_START=1020
CALM_T=520

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

to_mp3() { ffmpeg -y -i "$1" -c:a libmp3lame -q:a 3 "$2" >/dev/null 2>&1; }

snippet() {
  local src="$1" center="$2" out="$3"
  local start=$(( center > 10 ? center - 10 : 0 ))
  ffmpeg -y -ss "$start" -t 20 -i "$src" -c:a libmp3lame -q:a 3 "$out" >/dev/null 2>&1
}

HP="highpass=f=120"

echo "[1/8] 12-arnndn-marathon (highpass + RNNoise general/general model, full length)"
ffmpeg -y -i "$SRC" -af "$HP,arnndn=m=${MODELS}/marathon-prescription.rnnn" "$CLIPS/_12.wav" >/dev/null 2>&1
to_mp3 "$CLIPS/_12.wav" "$CLIPS/12-arnndn-marathon.mp3"
measure "12-arnndn-marathon" "$CLIPS/_12.wav"
snippet "$CLIPS/_12.wav" "$CALM_T" "$CLIPS/12a-arnndn-marathon-calm-snippet.mp3"
snippet "$CLIPS/_12.wav" "$WINDY_START" "$CLIPS/12b-arnndn-marathon-windy-snippet.mp3"

echo "[2/8] 13-arnndn-conjoined-burgers (highpass + RNNoise general/recording-noise model, full length)"
ffmpeg -y -i "$SRC" -af "$HP,arnndn=m=${MODELS}/conjoined-burgers.rnnn" "$CLIPS/_13.wav" >/dev/null 2>&1
to_mp3 "$CLIPS/_13.wav" "$CLIPS/13-arnndn-conjoined-burgers.mp3"
measure "13-arnndn-conjoined-burgers" "$CLIPS/_13.wav"
snippet "$CLIPS/_13.wav" "$CALM_T" "$CLIPS/13a-arnndn-conjoined-burgers-calm-snippet.mp3"
snippet "$CLIPS/_13.wav" "$WINDY_START" "$CLIPS/13b-arnndn-conjoined-burgers-windy-snippet.mp3"

echo "[3/8] 14-arnndn-beguiling-drafter (highpass + RNNoise VOICE-ONLY model — deliberate wrong-tool example, full length)"
ffmpeg -y -i "$SRC" -af "$HP,arnndn=m=${MODELS}/beguiling-drafter.rnnn" "$CLIPS/_14.wav" >/dev/null 2>&1
to_mp3 "$CLIPS/_14.wav" "$CLIPS/14-arnndn-beguiling-drafter.mp3"
measure "14-arnndn-beguiling-drafter (NEGATIVE example — voice-only model on ambient crowd audio)" "$CLIPS/_14.wav"
snippet "$CLIPS/_14.wav" "$CALM_T" "$CLIPS/14a-arnndn-beguiling-drafter-calm-snippet.mp3"
snippet "$CLIPS/_14.wav" "$WINDY_START" "$CLIPS/14b-arnndn-beguiling-drafter-windy-snippet.mp3"

echo "[4/8] 15-arnndn-marathon-plus-recommended (marathon RNNoise ADDED to the 03-gentle-dynaudnorm recipe, full length)"
ffmpeg -y -i "$SRC" -af "$HP,arnndn=m=${MODELS}/marathon-prescription.rnnn,dynaudnorm=f=2000:g=63:m=4:p=0.95,alimiter=limit=0.891:level=disabled" "$CLIPS/_15.wav" >/dev/null 2>&1
to_mp3 "$CLIPS/_15.wav" "$CLIPS/15-arnndn-marathon-plus-recommended.mp3"
measure "15-arnndn-marathon-plus-recommended (candidate: add RNNoise to 03)" "$CLIPS/_15.wav"
snippet "$CLIPS/_15.wav" "$CALM_T" "$CLIPS/15a-arnndn-marathon-plus-recommended-calm-snippet.mp3"
snippet "$CLIPS/_15.wav" "$WINDY_START" "$CLIPS/15b-arnndn-marathon-plus-recommended-windy-snippet.mp3"

echo "[5/8] cleanup intermediates"
rm -f "$CLIPS"/_1*.wav "$OUT_DIR/_tmp_ebur.log"

echo
echo "Done. mp3s in $CLIPS"
echo "Measurements in $REPORT"
