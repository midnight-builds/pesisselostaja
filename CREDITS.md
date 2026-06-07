# Credits, sources and licenses

Pesisselostaja itself is MIT-licensed (see [LICENSE](LICENSE)). It relies on
third-party voice models and libraries that have their **own** licenses. They are
**not** bundled into this repository — the browser downloads them at runtime from
the sources below — but they are listed here so usage and attribution are clear.

If you reuse this project, you are responsible for honouring each license below.

## Neural voices (Piper / ONNX models)

These power the optional "Edistynyt ääni (Piper)" feature. Models are fetched and
cached in the browser on first use.

| Voice | Author / dataset | License | Source |
| --- | --- | --- | --- |
| `fi_FI-harri-medium` | rhasspy / Piper — Finnish Single Speaker Speech Dataset | CC0 1.0 (public domain) | https://huggingface.co/rhasspy/piper-voices/tree/main/fi/fi_FI/harri |
| `fi_FI-harri-low` | rhasspy / Piper — Finnish Single Speaker Speech Dataset | CC0 1.0 (public domain) | https://huggingface.co/rhasspy/piper-voices/tree/main/fi/fi_FI/harri |
| `fi_FI-asmo-medium` | AsmoKoskinen | **CC BY-NC 4.0** | https://huggingface.co/AsmoKoskinen/Piper_Finnish_Model |

Notes:

- **Harri** is CC0 — no restrictions; attribution is given here as a courtesy.
- **Asmo** is **CC BY-NC 4.0**: it is a community model that is **non-commercial
  only** and **requires attribution**. Pesisselostaja is a free, non-commercial
  app, the voice is credited in the UI and here, and the model is not
  redistributed. If you fork this project for any commercial use, **remove the
  Asmo voice** or obtain separate permission from the author.

The canonical list (id, author, license, source) lives in code in
[`v2/src/piper.ts`](v2/src/piper.ts) so the UI, README and this file stay in sync.

## Speech / inference stack

| Component | Role | License | Source |
| --- | --- | --- | --- |
| Piper | Neural TTS model format and voices | MIT | https://github.com/rhasspy/piper |
| `@diffusionstudio/piper-wasm` | espeak-ng phonemizer compiled to WASM | espeak-ng is **GPL-3.0-or-later** | https://www.npmjs.com/package/@diffusionstudio/piper-wasm |
| onnxruntime-web | Runs the ONNX voice models in the browser | MIT | https://github.com/microsoft/onnxruntime |

The phonemizer embeds **espeak-ng (GPL-3.0-or-later)**. It is loaded from a CDN at
runtime and is not modified or redistributed by this repository.

## Data source

Live match data comes from **pesistulokset.fi**. This project is independent and is
not affiliated with, endorsed by, or sponsored by pesistulokset.fi. See the README
for details.
