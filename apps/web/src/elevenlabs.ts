// ElevenLabs TTS from the browser: the user pastes their own API key in the
// settings (stored in localStorage) and the browser calls the API directly —
// no proxy, so the public GitHub Pages deploy works identically. Same voice
// and model the broadcast pipeline uses.

export const ELEVENLABS_VOICE_ID = "nPczCjzI2devNBz1zQrb"; // Brian — valittu kuuntelemalla 2026-07-14
export const ELEVENLABS_MODEL_ID = "eleven_multilingual_v2";

export async function elevenLabsSynthesize(text: string, apiKey: string): Promise<Blob> {
  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}?output_format=mp3_44100_128`,
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
