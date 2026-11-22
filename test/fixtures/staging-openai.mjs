const originalFetch = globalThis.fetch;
const fixture = new URL(process.env.ZERA_STAGING_PROVIDER);
if (fixture.protocol !== 'http:' || fixture.hostname !== '127.0.0.1') {
  throw new Error('The staging OpenAI stub must run on loopback.');
}

globalThis.fetch = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input);
  if (url.origin !== 'https://api.openai.com')
    return originalFetch(input, init);
  const destination = new URL(url.pathname + url.search, fixture);
  return originalFetch(destination, init);
};
