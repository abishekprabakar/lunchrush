/** Number of bytes `text` takes as UTF-8, without allocating an encoded copy. */
export function utf8Length(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (isHighSurrogate(code) && isLowSurrogate(text.charCodeAt(i + 1))) {
      bytes += 4; // a surrogate pair is one 4-byte character
      i++;
    } else bytes += 3; // includes a lone surrogate, which UTF-8 encoders replace with U+FFFD
  }
  return bytes;
}

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;

/** Size of a message on the wire, as UTF-8 JSON. */
export function byteSize(message: unknown): number {
  return utf8Length(JSON.stringify(message));
}
