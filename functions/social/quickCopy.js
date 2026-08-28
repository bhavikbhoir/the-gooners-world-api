/**
 * Generic post copy generation for the Quick Draft composer.
 *
 * The admin picks a template and types the facts; Claude returns the caption
 * for both platforms PLUS the card's headline/subhead/tag. Hard rule: use ONLY
 * the details provided — never invent names, fees, dates, stats or quotes.
 */

const { BedrockRuntimeClient, InvokeModelCommand } = require('@aws-sdk/client-bedrock-runtime');

const bedrock = new BedrockRuntimeClient({ region: 'us-east-1' });
const MODEL = 'us.anthropic.claude-sonnet-4-6';

const GUIDES = {
  signing:      { tag: 'TRANSFER',      note: 'A new signing / transfer. Headline: a short punch like "SIGNED", "WELCOME", "HERE WE GO". Subhead: the player name (+ fee/loan/contract length only if given). Celebratory but grounded.' },
  injury:       { tag: 'INJURY UPDATE', note: 'An injury update. Headline: caring and calm (e.g. "GET WELL SOON") or the nature of the update. Subhead: player name (+ expected return only if given). Never speculate on severity beyond what is provided.' },
  appreciation: { tag: 'APPRECIATION',  note: 'A player appreciation post. Headline: warm and punchy (e.g. "WHAT A PLAYER", "PURE CLASS"). Subhead: player name (+ the stat/milestone if given). Only use stats provided.' },
  milestone:    { tag: 'MILESTONE',     note: 'A milestone (goals, appearances, birthday). Headline: the number or achievement. Subhead: player name + what it marks. Only use figures provided.' },
  onthisday:    { tag: 'ON THIS DAY',   note: 'A throwback. Headline: the year or the moment. Subhead: one line describing what happened. Use only the memory provided.' },
  award:        { tag: 'AWARD',         note: 'An award / recognition. Headline: the award. Subhead: the player. Proud but not arrogant.' },
  news:         { tag: 'NEWS',          note: 'A news reaction. Headline: a short line capturing the story. Subhead: the key detail. Base it only on the story provided.' },
  custom:       { tag: 'THE GOONERS WORLD', note: 'A general post. Headline: a short punchy line. Subhead: one supporting line. Base everything only on what is provided.' },
};

async function generateQuickCopy({ type, details, source, sourceUrl }) {
  const g = GUIDES[type] || GUIDES.custom;

  const sourceBlock = source ? `

A SOURCE ARTICLE was provided. Ground the caption only in facts supported by BOTH the admin details and this source. Then judge whether the admin's claim is actually supported by the source:
- If clearly supported → verification.supported = true.
- If the source does NOT clearly support the claim (or contradicts it) → verification.supported = false and explain briefly in verification.note. Still produce the copy, but do not overstate.
Source (${sourceUrl}):
"""
${source}
"""` : '';

  const verificationField = source
    ? `,"verification":{"supported":true|false,"note":"one short line"}`
    : '';

  const prompt = `You are the social media voice for The Gooners World, an Arsenal FC fan account (@thegoonersworld / @TheGoonersWorld). Passionate, real, never hyperbolic.

Post type: ${type}
Guidance: ${g.note}

Facts from the admin (use ONLY these — do NOT invent any name, number, fee, date, quote, or detail not present here):
"""
${details}
"""${sourceBlock}

Produce:
- instagram: full caption in fan voice, ending with 3-6 relevant hashtags (always include #Arsenal #COYG).
- x: a post ≤280 characters incl hashtags.
- headline: 1-3 WORDS, uppercase, for the graphic (punchy).
- subhead: one short line for the graphic (e.g. the player name / key detail).
- tag: a short label for the graphic (default "${g.tag}").

Respond with ONLY valid JSON, no prose:
{"instagram":"...","x":"...","headline":"...","subhead":"...","tag":"..."${verificationField}}`;

  const response = await bedrock.send(new InvokeModelCommand({
    modelId: MODEL,
    contentType: 'application/json',
    accept: 'application/json',
    body: JSON.stringify({
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: 700,
      messages: [{ role: 'user', content: prompt }],
    }),
  }));

  const raw = JSON.parse(Buffer.from(response.body).toString()).content[0].text.trim();
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('Model did not return valid JSON');
  const out = JSON.parse(jsonMatch[0]);
  if (!out.tag) out.tag = g.tag;
  return out;
}

module.exports = { generateQuickCopy, GUIDES };
