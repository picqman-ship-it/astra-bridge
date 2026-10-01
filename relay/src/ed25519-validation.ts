// Encoding guard only: curve/signature verification remains in platform WebCrypto.
// Small-order y coordinates cross-checked against Node's reviewed canonical table:
// https://github.com/nodejs/node/blob/29890721cda51eeb64f4079143d55b69333599c2/src/crypto/crypto_sig.cc
// Masking the sign bit covers all 8 canonical points and the x=0 sign aliases.
const SMALL_ORDER_Y = [
  "00".repeat(32),
  "01" + "00".repeat(31),
  "ec" + "ff".repeat(30) + "7f",
  "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a",
  "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05",
];

function littleEndian(bytes: Uint8Array): bigint {
  let result = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) result = (result << 8n) | BigInt(bytes[i]);
  return result;
}

export function canonicalNonSmallOrderPoint(raw: Uint8Array): boolean {
  if (raw.length !== 32) return false;
  const y = raw.slice();
  y[31] &= 0x7f;
  if (littleEndian(y) >= (1n << 255n) - 19n) return false;
  const hex = [...y].map(b => b.toString(16).padStart(2, "0")).join("");
  return !SMALL_ORDER_Y.includes(hex);
}

export function canonicalSignature(signature: Uint8Array): boolean {
  return signature.length === 64 && canonicalNonSmallOrderPoint(signature.slice(0, 32))
    && littleEndian(signature.slice(32)) < (1n << 252n) + 27742317777372353535851937790883648493n;
}

/** Shared guard for enrollment AND legacy/manually provisioned D1 key rows. */
export function canonicalAgentKey(value: unknown): Uint8Array<ArrayBuffer> | null {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]{59}=$/.test(value)) return null;
  try {
    const bytes = Uint8Array.from(atob(value), c => c.charCodeAt(0));
    const prefix = [0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00];
    return bytes.length === 44 && btoa(String.fromCharCode(...bytes)) === value
      && prefix.every((b, i) => bytes[i] === b) && canonicalNonSmallOrderPoint(bytes.slice(12)) ? bytes : null;
  } catch { return null; }
}
