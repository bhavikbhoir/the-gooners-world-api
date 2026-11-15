/**
 * Narration — Amazon Polly, British English, one voice per competition.
 *
 * The voice is part of the brand the same way the card accent colour is, so the
 * mapping mirrors compTheme() in graphics.js: a viewer should recognise a
 * Champions League night from the first syllable.
 *
 * Running on the standard engine, which has a 5M character/month free tier that
 * never expires — roughly 300x our annual volume, so narration costs nothing.
 * Standard rules out Arthur (neural-only), leaving three en-GB voices for six
 * competitions, so the lower-volume cups double up.
 *
 * Upgrading is a one-line change: neural is ~$3/yr at our volume and sounds
 * clearly better, generative better still at ~$5.60/yr. Worth revisiting once
 * the channel is earning anything at all.
 */

const { PollyClient, SynthesizeSpeechCommand } = require('@aws-sdk/client-polly');

const polly = new PollyClient({ region: process.env.AWS_REGION || 'us-east-1' });

const ENGINE = 'standard';

const VOICES = {
  premier: { voiceId: 'Amy', engine: ENGINE },
  champions: { voiceId: 'Brian', engine: ENGINE },
  europa: { voiceId: 'Emma', engine: ENGINE },
  facup: { voiceId: 'Emma', engine: ENGINE },
  carabao: { voiceId: 'Brian', engine: ENGINE },
  default: { voiceId: 'Amy', engine: ENGINE },
};

/** Mirrors the competition matching in graphics.js compTheme(). */
function voiceFor(competition) {
  const n = (competition || '').toLowerCase();
  if (n.includes('premier')) return VOICES.premier;
  if (n.includes('champions')) return VOICES.champions;
  if (n.includes('europa')) return VOICES.europa;
  if (n.includes('fa cup')) return VOICES.facup;
  if (n.includes('carabao') || n.includes('efl') || n.includes('league cup')) return VOICES.carabao;
  return VOICES.default;
}

// MPEG audio frame tables, Layer III only — enough to measure what Polly emits.
const BITRATES_V1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
const BITRATES_V2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0];
const RATES = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

/**
 * Exact duration by walking MPEG frame headers.
 *
 * Polly's generative engine refuses speech-mark output, so timings can't come
 * from the API for every voice. Summing frame durations works for any engine
 * and saves a second synthesis call.
 */
function mp3DurationMs(buf) {
  let ms = 0;
  let i = 0;
  // Skip an ID3v2 tag if present.
  if (buf.length > 10 && buf.toString('ascii', 0, 3) === 'ID3') {
    i = 10 + ((buf[6] & 0x7f) << 21 | (buf[7] & 0x7f) << 14 | (buf[8] & 0x7f) << 7 | (buf[9] & 0x7f));
  }
  while (i + 4 <= buf.length) {
    if (buf[i] !== 0xff || (buf[i + 1] & 0xe0) !== 0xe0) { i += 1; continue; }

    const versionBits = (buf[i + 1] >> 3) & 0x03;   // 3 = MPEG1, 2 = MPEG2, 0 = MPEG2.5
    const layerBits = (buf[i + 1] >> 1) & 0x03;     // 1 = Layer III
    const bitrateIdx = (buf[i + 2] >> 4) & 0x0f;
    const rateIdx = (buf[i + 2] >> 2) & 0x03;
    const padding = (buf[i + 2] >> 1) & 0x01;

    const rates = RATES[versionBits];
    if (layerBits !== 1 || !rates || rateIdx === 3 || bitrateIdx === 0 || bitrateIdx === 15) {
      i += 1;
      continue;
    }

    const sampleRate = rates[rateIdx];
    const bitrate = (versionBits === 3 ? BITRATES_V1[bitrateIdx] : BITRATES_V2[bitrateIdx]) * 1000;
    const samples = versionBits === 3 ? 1152 : 576;
    const frameLen = Math.floor((samples / 8) * bitrate / sampleRate) + padding;
    if (frameLen <= 0) { i += 1; continue; }

    ms += (samples / sampleRate) * 1000;
    i += frameLen;
  }
  return Math.round(ms);
}

/** One scene's line: mp3 bytes, exact length, and word timings for captions. */
async function synthesizeOne(text, voiceId, engine) {
  const common = { Text: text, VoiceId: voiceId, Engine: engine, LanguageCode: 'en-GB' };

  const [speech, marks] = await Promise.all([
    polly.send(new SynthesizeSpeechCommand({ ...common, OutputFormat: 'mp3' })),
    polly.send(new SynthesizeSpeechCommand({
      ...common, OutputFormat: 'json', SpeechMarkTypes: ['word'],
    })),
  ]);

  const audio = Buffer.from(await speech.AudioStream.transformToByteArray());
  const words = (await marks.AudioStream.transformToString())
    .split('\n').filter(Boolean)
    .map((l) => JSON.parse(l))
    .map((m) => ({ t: m.time, w: m.value }));

  return { audio, durationMs: mp3DurationMs(audio), words };
}

/**
 * Narration for one video, synthesised per scene.
 *
 * Earlier this was a single blob with scene lengths guessed from weights, and
 * the visuals drifted behind the voice. Synthesising each scene's line
 * separately makes its duration a measured fact, so the composition can cut
 * exactly when the sentence ends — sync is correct by construction rather than
 * by tuning.
 *
 * @param lines  ordered [{ key, text }] — one per scene, in scene order
 * @returns {Promise<{audio: Buffer, durationMs: number, segments: Array, voiceId: string, engine: string}>}
 */
async function synthesizeNarration({ lines, competition }) {
  if (!Array.isArray(lines) || !lines.length) throw new Error('Narration has no lines');

  const { voiceId, engine } = voiceFor(competition);

  const spoken = await Promise.all(
    lines.map(({ text }) => synthesizeOne(String(text || '').trim() || '…', voiceId, engine)),
  );

  let offsetMs = 0;
  const segments = spoken.map((s, i) => {
    const seg = {
      key: lines[i].key,
      text: lines[i].text,
      startMs: offsetMs,
      durationMs: s.durationMs,
      // Word times are per-segment from Polly; shift them onto the full timeline.
      words: s.words.map((w) => ({ t: w.t + offsetMs, w: w.w })),
    };
    offsetMs += s.durationMs;
    return seg;
  });

  return {
    audio: Buffer.concat(spoken.map((s) => s.audio)),
    durationMs: offsetMs,
    segments,
    voiceId,
    engine,
  };
}

module.exports = { synthesizeNarration, voiceFor, mp3DurationMs, VOICES };
