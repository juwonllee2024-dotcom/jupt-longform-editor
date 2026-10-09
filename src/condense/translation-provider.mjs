const DEFAULT_ENDPOINT = 'http://127.0.0.1:11434/api/chat';
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function decodeJsonContent(content) {
  const trimmed = String(content || '').trim();
  const withoutFence = trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  try {
    return JSON.parse(withoutFence);
  } catch {
    const start = withoutFence.indexOf('{');
    const end = withoutFence.lastIndexOf('}');
    if (start < 0 || end <= start) throw new Error('Ollama translation JSON invalid');
    return JSON.parse(withoutFence.slice(start, end + 1));
  }
}

function normalizeTranslation(value) {
  const candidates = Array.isArray(value) ? value : value?.segments;
  if (!Array.isArray(candidates)) throw new Error('Ollama translation segments missing');
  const words = candidates
    .map((segment) => ({
      word: cleanText(segment?.text ?? segment?.word),
      start: Number(segment?.start),
      end: Number(segment?.end),
    }))
    .filter((segment) => (
      segment.word
      && Number.isFinite(segment.start)
      && Number.isFinite(segment.end)
      && segment.start >= 0
      && segment.end > segment.start
    ))
    .sort((left, right) => left.start - right.start || left.end - right.end);
  if (words.length === 0) throw new Error('Ollama translation returned no usable segments');
  return words;
}

export function createOllamaTranslator({
  endpoint = DEFAULT_ENDPOINT,
  model = 'qwen3:8b',
  timeoutMs = 120_000,
  fetchImpl = fetch,
} = {}) {
  const url = new URL(endpoint);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Ollama endpoint must use http or https');
  const modelName = cleanText(model);
  if (!modelName || modelName.length > 120) throw new Error('Ollama model is required');
  return async ({ segments } = {}) => {
    const selected = (Array.isArray(segments) ? segments : [])
      .map((segment) => ({
        start: Number(segment?.start),
        end: Number(segment?.end),
        text: cleanText(segment?.text),
      }))
      .filter((segment) => segment.text && Number.isFinite(segment.start) && Number.isFinite(segment.end) && segment.end > segment.start);
    if (selected.length === 0) return [];
    const prompt = [
      'Translate each source segment into natural Korean.',
      'Return JSON only in the form {"segments":[{"start":number,"end":number,"text":"한국어"}]}.' ,
      'Keep every start/end timestamp unchanged. Do not add facts, omit segments, or include commentary.',
      JSON.stringify(selected),
    ].join('\n');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetchImpl(url.href, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: modelName,
          messages: [{ role: 'user', content: prompt }],
          stream: false,
          format: 'json',
          options: { temperature: 0 },
        }),
        signal: controller.signal,
      });
    } catch (error) {
      const reason = error?.name === 'AbortError' ? 'timeout' : 'network';
      throw new Error(`Ollama translation request failed: ${reason}`);
    } finally {
      clearTimeout(timeout);
    }
    if (!response?.ok) throw new Error(`Ollama translation request failed: ${Number(response?.status) || 500}`);
    const body = await response.text();
    if (Buffer.byteLength(body, 'utf8') > MAX_RESPONSE_BYTES) throw new Error('Ollama translation response exceeds 2 MiB');
    let payload;
    try {
      payload = JSON.parse(body);
    } catch {
      throw new Error('Ollama response JSON invalid');
    }
    return normalizeTranslation(decodeJsonContent(payload?.message?.content));
  };
}

export { DEFAULT_ENDPOINT };
