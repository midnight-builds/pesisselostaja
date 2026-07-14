# FfmpegMixer gets a test-only source-resolution seam

DESIGN.md is explicit that the relay never needs a fake/local source path in
production — it always pulls a real, already-published YouTube livestream via
`resolveSourceUrl`/yt-dlp. But the 144203 incident (selostus katosi
flappauksen aikana — see HANDOFF.md) can only be investigated by reproducing
many respawns with a *deterministic*, ~33s-EOF source, which a real HLS pull
can't guarantee on demand.

We added `FfmpegMixerOptions.resolveTestSource` — an optional resolver
function, called once per spawn attempt in place of `resolveSourceUrl`, that
lets a harness feed `-i` a local fixture file directly (read with `-re`
instead of the production reconnect/http-persistent flags, which are
HTTP/HLS-specific and meaningless against a file). It's a function rather
than a static string so a harness can vary the source per respawn (e.g. one
deliberately longer session, to separate "amix drops narration on short
sessions" from "narration never reconnects at all" — see
`apps/broadcast/src/flapTest.ts`).

**Trade-off accepted:** this permanently widens `FfmpegMixer`'s public
surface with an option that must never be set in production. We considered
instead building a full local HLS server (closer to yt-dlp's real code
path) but rejected it — it adds two more moving parts (an HTTP server,
yt-dlp's generic-HLS extractor behaviour) that could themselves misbehave
and confound which hypothesis the test confirms. A plain function seam
keeps the fixture path fully under the test's control and out of yt-dlp's
hands entirely.
