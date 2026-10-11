export function applyFetchPatch() {
  const apiKeys = (process.env.ASTRA_AI_API_KEY || '').split(',').map(k => k.trim()).filter(Boolean);
  if (apiKeys.length <= 1) return;

  const originalFetch = globalThis.fetch;
  let currentKeyIndex = 0;

  globalThis.fetch = async function (url: string | URL | Request, options?: RequestInit) {
    let urlString = typeof url === 'string' ? url : ((url as any).url || url.toString());
    
    // Quick escape if not openrouter
    if (!urlString.includes('openrouter.ai')) {
      return originalFetch(url, options);
    }

    // Determine if this is an authenticated request
    let hasAuth = false;
    let reqHeaders: Headers = new Headers(options?.headers || (url as any).headers);
    hasAuth = reqHeaders.has('authorization');

    if (!hasAuth) {
      return originalFetch(url, options);
    }

    // Try keys
    let attempts = 0;
    while (attempts < apiKeys.length) {
      const currentKey = apiKeys[currentKeyIndex];
      
      // We must construct the fetch args properly.
      // Easiest is to extract everything into options if url is a Request.
      // But actually, we can just pass the original string url and rebuild options.
      let finalUrl = urlString;
      let finalOptions: RequestInit = { ...options };
      
      if (typeof url === 'object' && 'url' in url) {
         // It's a Request object (or similar).
         finalOptions.method = finalOptions.method || (url as any).method;
         finalOptions.body = finalOptions.body || (url as any).body;
         finalOptions.credentials = finalOptions.credentials || (url as any).credentials;
         finalOptions.mode = finalOptions.mode || (url as any).mode;
      }
      
      const newHeaders = new Headers(reqHeaders);
      newHeaders.set('Authorization', `Bearer ${currentKey}`);
      finalOptions.headers = newHeaders;

      let response;
      try {
        response = await originalFetch(finalUrl, finalOptions);
      } catch (e) {
        console.error(`[API Rotation] fetch exception:`, e);
        throw e;
      }

      // 429 Too Many Requests, 402 Payment Required (OpenRouter quota)
      if (response.status === 429 || response.status === 402) {
         console.warn(`[API Rotation] Key ${currentKeyIndex + 1}/${apiKeys.length} exhausted or rate limited. Rotating...`);
         currentKeyIndex = (currentKeyIndex + 1) % apiKeys.length;
         attempts++;
         continue;
      }

      if (!response.ok) {
         // Optionally log but don't rotate on 400 Bad Request, etc.
         const cloned = response.clone();
         const bodyText = await cloned.text().catch(() => '');
         console.error(`[API Rotation] HTTP ${response.status}: ${bodyText}`);
      }

      return response;
    }
    
    // Fallback if all keys fail (should return the last 429 response)
    return originalFetch(url, options);
  };
}
