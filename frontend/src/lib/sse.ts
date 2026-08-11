import lz4 from 'lz4js';

const PREFIX = 'lz4:';

export function decodeSSE(payload: string): string {
  if (typeof payload === 'string' && payload.startsWith(PREFIX)) {
    try {
      const bin = atob(payload.slice(PREFIX.length));
      const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
      return new TextDecoder().decode(lz4.decompress(bytes));
    } catch {
      return payload;
    }
  }
  return payload;
}
