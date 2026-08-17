// ElevenLabs TTS from the browser: the user pastes their own API key in the
// settings (stored in localStorage) and the browser calls the API directly —
// no proxy, so the public GitHub Pages deploy works identically. Same voice
// and model the broadcast pipeline uses.

import { spellOutNumbers } from "@pesisselostaja/core";

export const ELEVENLABS_DEFAULT_VOICE_ID = "onwK4e9ZLuTAKqWW03F9"; // Daniel — valittu kuuntelemalla 2026-07-15
export const ELEVENLABS_MODEL_ID = "eleven_multilingual_v2";

/** Asetuksen ääni-ID → tosiasiassa käytettävä ID (issue #63).
 *  Tyhjä tai pelkkää tyhjämerkkiä oleva asetus tarkoittaa "käytä oletusta",
 *  jotta kentän tyhjentäminen palauttaa aina toimivan äänen. */
export function resolveElevenLabsVoiceId(configured?: string | null): string {
  const trimmed = (configured ?? "").trim();
  return trimmed === "" ? ELEVENLABS_DEFAULT_VOICE_ID : trimmed;
}

export async function elevenLabsSynthesize(
  rawText: string,
  apiKey: string,
  voiceId?: string,
): Promise<Blob> {
  // EL reads bare digits unclearly in short Finnish phrases.
  // — spell them out as words on this path only; Piper/Web Speech read digits fine.
  const text = spellOutNumbers(rawText);
  const voice = resolveElevenLabsVoiceId(voiceId);
  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}?output_format=mp3_44100_128`,
    {
      method: "POST",
      headers: { "xi-api-key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ text, model_id: ELEVENLABS_MODEL_ID }),
    }
  );
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 200);
    throw new Error(`ElevenLabs HTTP ${res.status}: ${detail}`);
  }
  return res.blob();
}
