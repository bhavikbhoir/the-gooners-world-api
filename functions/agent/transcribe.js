/**
 * Voice input fallback — Amazon Transcribe
 *
 * Browsers without a working Web Speech recognizer (Chrome/Firefox/Edge on
 * iOS, Firefox desktop) record the user's question themselves and post it
 * here as 16 kHz mono 16-bit PCM. We stream it to Transcribe and return the
 * final transcript; the frontend then sends that text to agent/chat.
 */

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',');
const SAMPLE_RATE = 16000;
const MAX_SECONDS = 20;
const MAX_BYTES = SAMPLE_RATE * 2 * MAX_SECONDS;
const CHUNK_BYTES = 6400; // 200 ms of audio per event

// ── Rate limiter ───────────────────────────────────────────────────
const ipCounts = {};
function checkRate(ip, now = Date.now()) {
  if (!ipCounts[ip] || now - ipCounts[ip].start > 600000) { ipCounts[ip] = { count: 1, start: now }; return true; }
  return ++ipCounts[ip].count <= 60;
}

function cors(origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return { 'Access-Control-Allow-Origin': allowed, 'Access-Control-Allow-Headers': 'Content-Type,x-api-key', 'Access-Control-Allow-Methods': 'POST,OPTIONS', 'Vary': 'Origin' };
}

// Returns the decoded PCM buffer, or an error string.
function decodeAudio(b64) {
  if (typeof b64 !== 'string' || !b64) return { error: 'audio required' };
  // base64 is 4/3 the size of the bytes it encodes — reject before decoding
  if (b64.length > Math.ceil(MAX_BYTES / 3) * 4) return { error: 'Recording too long.' };
  const pcm = Buffer.from(b64, 'base64');
  if (pcm.length < SAMPLE_RATE * 2 * 0.3) return { error: 'Recording too short.' };
  if (pcm.length % 2) return { error: 'Invalid audio.' };
  return { pcm };
}

async function* audioStream(pcm) {
  for (let i = 0; i < pcm.length; i += CHUNK_BYTES) {
    yield { AudioEvent: { AudioChunk: pcm.subarray(i, i + CHUNK_BYTES) } };
  }
}

exports.decodeAudio = decodeAudio;
exports.checkRate = checkRate;

exports.handler = async (event) => {
  const origin = event.headers?.origin || event.headers?.Origin || '';
  const headers = cors(origin);

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  const ip = event.requestContext?.identity?.sourceIp || 'unknown';
  if (!checkRate(ip)) return { statusCode: 429, headers, body: JSON.stringify({ error: 'Too many requests.' }) };

  try {
    const { audio } = JSON.parse(event.body || '{}');
    const { pcm, error } = decodeAudio(audio);
    if (error) return { statusCode: 400, headers, body: JSON.stringify({ error }) };

    const { TranscribeStreamingClient, StartStreamTranscriptionCommand } = await import('@aws-sdk/client-transcribe-streaming');
    const client = new TranscribeStreamingClient({ region: process.env.AWS_REGION || 'us-east-1' });

    const response = await client.send(new StartStreamTranscriptionCommand({
      LanguageCode: 'en-GB',
      MediaEncoding: 'pcm',
      MediaSampleRateHertz: SAMPLE_RATE,
      AudioStream: audioStream(pcm),
    }));

    const parts = [];
    for await (const evt of response.TranscriptResultStream) {
      for (const result of evt.TranscriptEvent?.Transcript?.Results || []) {
        if (!result.IsPartial && result.Alternatives?.[0]?.Transcript) parts.push(result.Alternatives[0].Transcript);
      }
    }

    return {
      statusCode: 200,
      headers: { ...headers, 'Cache-Control': 'no-cache' },
      body: JSON.stringify({ text: parts.join(' ').trim() }),
    };
  } catch (err) {
    console.error('Transcribe error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Could not transcribe audio. Please try again.' }) };
  }
};
