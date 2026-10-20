import { parseJSON } from './core.mjs';
const fault = code => Object.assign(new Error(code), { code });
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

// Endpoint stays in this closure and never enters generated reports.
export function httpTransport(endpoint, options = {}) {
  let url;
  try { url = new URL(endpoint); } catch { throw new Error('Invalid endpoint URL'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.hash) throw new Error('Use HTTP(S) without embedded credentials or fragments');
  if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('Remote endpoints must use HTTPS');
  const { timeoutMs = 5000, retries = 1, fetchImpl = fetch, sleep = wait } = options;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000 || !Number.isInteger(retries) || retries < 0 || retries > 3) throw new Error('Invalid transport limits');
  return async request => {
    for (let attempt = 0; ; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let retryable = false, failure;
      try {
        const response = await fetchImpl(url.href, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify(request), signal: controller.signal, redirect: 'error'
        });
        if (!response.ok) {
          retryable = [429, 502, 503, 504].includes(response.status);
          await response.body?.cancel();
          throw fault('HTTP');
        }
        const reader = response.body?.getReader();
        if (!reader) throw fault('JSON');
        let length = 0;
        const chunks = [];
        try {
          while (true) {
            const part = await reader.read();
            if (part.done) break;
            length += part.value.byteLength;
            if (length > 1048576) { await reader.cancel(); throw fault('SIZE'); }
            chunks.push(Buffer.from(part.value));
          }
        } finally { reader.releaseLock(); }
        try { return parseJSON(Buffer.concat(chunks).toString('utf8')); }
        catch { throw fault('JSON'); }
      } catch (error) {
        if (controller.signal.aborted) { failure = fault('TIMEOUT'); retryable = true; }
        else if (error.code) failure = fault(error.code);
        else { failure = fault('NETWORK'); retryable = true; }
      } finally { clearTimeout(timer); }
      if (!retryable || attempt >= retries) throw failure;
      await sleep(100 * 2 ** attempt);
    }
  };
}
