export function withoutLocalConnectionReuse(request = globalThis.fetch) {
  return (input, init) => {
    let url;
    try {
      url = new URL(input instanceof Request ? input.url : String(input));
    } catch {
      return request(input, init);
    }
    if (!["http:", "https:"].includes(url.protocol)
      || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) return request(input, init);
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    headers.set("connection", "close");
    return request(input, { ...init, headers });
  };
}

globalThis.fetch = withoutLocalConnectionReuse();
