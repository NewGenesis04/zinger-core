import lz4 from 'lz4js';

const PREFIX = 'lz4:';
const MIN_COMPRESS_BYTES = 256;

const encoder = new TextEncoder();

export function compressText(text) {
  const bytes = encoder.encode(text);
  if (bytes.length < MIN_COMPRESS_BYTES) return text;
  try {
    const compressed = lz4.compress(bytes);
    const b64 = Buffer.from(compressed).toString('base64');
    return `${PREFIX}${b64}`;
  } catch {
    return text;
  }
}

export function sseLine(data) {
  const text = typeof data === 'string' ? data : JSON.stringify(data);
  return `data: ${compressText(text)}\n\n`;
}

export function ssePing() {
  return `: ping ${Date.now()}\n\n`;
}
