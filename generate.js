// netlify/functions/generate.js
//
// This runs on Netlify's servers, never in the browser. Your Anthropic API key
// lives only here, as an environment variable — it is never sent to the client.
//
// Set these in Netlify: Site settings → Environment variables
//   ANTHROPIC_API_KEY   your key from console.anthropic.com
//   ADMIN_KEY            a password you make up, e.g. a long random string
//
// The admin page (/admin/generate.html) asks for ADMIN_KEY once and sends it
// with every request, so a stranger who finds this URL can't burn through
// your API budget without knowing that password.

const ICONS = [
  'fas fa-lightbulb', 'fas fa-gavel', 'fas fa-leaf', 'fas fa-balance-scale',
  'fas fa-globe', 'fas fa-heart', 'fas fa-brain', 'fas fa-flask',
  'fas fa-comment', 'fas fa-chart-line', 'fas fa-users', 'fas fa-star'
];

const LEVEL_GUIDANCE = {
  B2: 'Vocabulary should be everyday-plus: words a solid intermediate learner would find genuinely useful but not yet secure in (avoid basic words like "big" or "happy", avoid rare/literary words). Quiz questions should mostly be literal/detail with one or two light inference questions.',
  C1: 'Vocabulary should be advanced: less frequent words, collocations, and phrasal expressions a C1 learner is still consolidating. Include some inference and tone/attitude questions in the quiz, not just detail recall.',
  C2: 'Vocabulary should be sophisticated: idiomatic expressions, low-frequency or nuanced words, connotation-rich language. Quiz questions should lean heavily on inference, implication, tone, and subtle meaning rather than simple detail recall.'
};

function buildPrompt(paragraphs, level) {
  const numbered = paragraphs.map((p, i) => `[Paragraph ${i}]\n${p}`).join('\n\n');
  const levelGuidance = LEVEL_GUIDANCE[level] || LEVEL_GUIDANCE.B2;

  return `Read this article (already split into numbered paragraphs) and build a complete reading lesson for a ${level} (CEFR) English learner.

${levelGuidance}

ARTICLE:
${numbered}

Return ONLY a single JSON object with exactly this shape:

{
  "title": "a concise, engaging lesson title (not necessarily the article's original headline)",
  "eyebrow": "a short topic tag, e.g. 'Legal Dispatch · Italy' (max 6 words)",
  "subtitle": "one sentence subtitle for students, capturing the hook of the article",
  "paragraphs": [
    { "index": 0, "words": [ { "word": "EXACT substring copied verbatim from paragraph 0's text, correct case", "def": "simple one-sentence student-friendly definition, without using the word itself", "synonym": "one simple everyday synonym or short paraphrase (1-3 words)" } ] },
    { "index": 1, "words": [ ... ] }
  ],
  "survey": [
    { "question": "an opinion or prediction question that quotes an exact short phrase from the article in double quotes, to prime vocabulary before reading", "options": ["option 1","option 2","option 3","option 4"] }
  ],
  "quiz": [
    { "q": "a comprehension question about the article", "opts": ["option A","option B","option C","option D"], "a": 0 }
  ],
  "takeaways": [
    { "icon": "one of: ${ICONS.join(', ')}", "text": "one key idea from the article, phrased as a short standalone sentence" }
  ]
}

Rules:
- "paragraphs" must contain one entry per input paragraph, in the same order, using the same "index" values shown above (0-based).
- Mark 1-3 vocabulary words per paragraph, 6-10 total across the whole article — only words that actually appear verbatim (same spelling/case, singular form is fine even if plural appears) as a substring within that paragraph's own text. Never invent a word that isn't in the paragraph.
- Do not mark proper nouns, numbers, or basic function words.
- Write exactly 3 survey questions and 5 quiz questions and 3 takeaways.
- For quiz questions, "a" is the zero-based index of the correct option in "opts". Make distractors plausible, not silly.
- Every options/opts array must have exactly 4 entries.
- Output must be valid JSON with no trailing commas, no comments, and no text outside the JSON object.`;
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, x-admin-key',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  // ── simple password gate ──
  const suppliedKey = event.headers['x-admin-key'];
  if (!process.env.ADMIN_KEY || suppliedKey !== process.env.ADMIN_KEY) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server is missing ANTHROPIC_API_KEY' }) };
  }

  let paragraphs, level;
  try {
    const body = JSON.parse(event.body || '{}');
    paragraphs = body.paragraphs;
    level = body.level;
    if (!Array.isArray(paragraphs) || paragraphs.length === 0) throw new Error('paragraphs required');
    if (!['B2', 'C1', 'C2'].includes(level)) throw new Error('level must be B2, C1, or C2');
  } catch (err) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Bad request: ' + err.message }) };
  }

  try {
    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 4000,
        system: 'You are an expert CEFR-aligned ESL/EFL lesson designer. You always respond with ONLY a single valid JSON object — no markdown code fences, no commentary, no leading or trailing text.',
        messages: [{ role: 'user', content: buildPrompt(paragraphs, level) }]
      })
    });

    if (!anthropicRes.ok) {
      const errText = await anthropicRes.text();
      return { statusCode: 502, headers, body: JSON.stringify({ error: 'Anthropic API error: ' + errText }) };
    }

    const data = await anthropicRes.json();
    const textBlocks = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
    const cleaned = textBlocks.replace(/```json|```/g, '').trim();

    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (e) {
      const match = cleaned.match(/\{[\s\S]*\}/);
      if (!match) throw new Error('Could not parse generated lesson JSON');
      parsed = JSON.parse(match[0]);
    }

    return { statusCode: 200, headers, body: JSON.stringify(parsed) };

  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
