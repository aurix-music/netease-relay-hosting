// Shared shapes for the .mjs sources. Global on purpose: a JSDoc typedef in a
// .mjs file is module-local. Never loaded at runtime.

interface RelayResponse {
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}

interface RelayRequestInit {
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

type RelayFetcher = (url: string | URL, init?: RelayRequestInit) => Promise<RelayResponse>;

interface RelayClient {
  label: string;
  fetch: RelayFetcher;
}
