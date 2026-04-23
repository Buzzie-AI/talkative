import { describe, test, expect } from 'vitest';
import naclUtil from 'tweetnacl-util';
import {
  generateKeypair,
  encryptFor,
  decryptFrom,
} from '../../channel/crypto';

const NACL_KEY_BYTES = 32;
const BASE64_KEY_LEN = 44;

function flipByte(b64: string, index: number): string {
  const bytes = naclUtil.decodeBase64(b64);
  bytes[index] = bytes[index] ^ 0xff;
  return naclUtil.encodeBase64(bytes);
}

describe('generateKeypair', () => {
  test('returns base64 keys of the expected length', () => {
    const { publicKey, secretKey } = generateKeypair();
    expect(publicKey).toHaveLength(BASE64_KEY_LEN);
    expect(secretKey).toHaveLength(BASE64_KEY_LEN);
    expect(naclUtil.decodeBase64(publicKey).length).toBe(NACL_KEY_BYTES);
    expect(naclUtil.decodeBase64(secretKey).length).toBe(NACL_KEY_BYTES);
  });

  test('public and secret halves differ', () => {
    const kp = generateKeypair();
    expect(kp.publicKey).not.toBe(kp.secretKey);
  });

  test('successive calls produce different keypairs', () => {
    const a = generateKeypair();
    const b = generateKeypair();
    expect(a.publicKey).not.toBe(b.publicKey);
    expect(a.secretKey).not.toBe(b.secretKey);
  });
});

describe('encryptFor / decryptFrom roundtrip', () => {
  test('Alice → Bob roundtrips plaintext', () => {
    const alice = generateKeypair();
    const bob = generateKeypair();
    const plaintext = 'hello bob';
    const { nonce, ciphertext } = encryptFor(bob.publicKey, alice.secretKey, plaintext);
    const decoded = decryptFrom(alice.publicKey, bob.secretKey, nonce, ciphertext);
    expect(decoded).toBe(plaintext);
  });

  test('Bob → Alice roundtrips plaintext', () => {
    const alice = generateKeypair();
    const bob = generateKeypair();
    const plaintext = 'reply from bob';
    const { nonce, ciphertext } = encryptFor(alice.publicKey, bob.secretKey, plaintext);
    const decoded = decryptFrom(bob.publicKey, alice.secretKey, nonce, ciphertext);
    expect(decoded).toBe(plaintext);
  });

  test('nonce and ciphertext are valid base64', () => {
    const alice = generateKeypair();
    const bob = generateKeypair();
    const { nonce, ciphertext } = encryptFor(bob.publicKey, alice.secretKey, 'x');
    expect(() => naclUtil.decodeBase64(nonce)).not.toThrow();
    expect(() => naclUtil.decodeBase64(ciphertext)).not.toThrow();
  });
});

describe('payload shapes', () => {
  const alice = generateKeypair();
  const bob = generateKeypair();

  const cases: Array<[string, string]> = [
    ['empty string', ''],
    ['ascii single char', 'x'],
    ['unicode emoji', '👋🌍 hello'],
    ['japanese', 'こんにちは、世界'],
    ['newlines and tabs', 'line1\nline2\tcol'],
    ['10KB blob', 'a'.repeat(10_000)],
  ];

  test.each(cases)('roundtrips %s', (_name, plaintext) => {
    const { nonce, ciphertext } = encryptFor(bob.publicKey, alice.secretKey, plaintext);
    const decoded = decryptFrom(alice.publicKey, bob.secretKey, nonce, ciphertext);
    expect(decoded).toBe(plaintext);
  });
});

describe('nonce uniqueness and non-determinism', () => {
  test('encrypting the same plaintext twice yields different nonces', () => {
    const alice = generateKeypair();
    const bob = generateKeypair();
    const a = encryptFor(bob.publicKey, alice.secretKey, 'same');
    const b = encryptFor(bob.publicKey, alice.secretKey, 'same');
    expect(a.nonce).not.toBe(b.nonce);
  });

  test('encrypting the same plaintext twice yields different ciphertexts', () => {
    const alice = generateKeypair();
    const bob = generateKeypair();
    const a = encryptFor(bob.publicKey, alice.secretKey, 'same');
    const b = encryptFor(bob.publicKey, alice.secretKey, 'same');
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });
});

describe('failure modes return null, never throw', () => {
  test('tampered ciphertext returns null', () => {
    const alice = generateKeypair();
    const bob = generateKeypair();
    const { nonce, ciphertext } = encryptFor(bob.publicKey, alice.secretKey, 'secret');
    const tampered = flipByte(ciphertext, 0);
    expect(decryptFrom(alice.publicKey, bob.secretKey, nonce, tampered)).toBeNull();
  });

  test('tampered nonce returns null', () => {
    const alice = generateKeypair();
    const bob = generateKeypair();
    const { nonce, ciphertext } = encryptFor(bob.publicKey, alice.secretKey, 'secret');
    const tampered = flipByte(nonce, 0);
    expect(decryptFrom(alice.publicKey, bob.secretKey, tampered, ciphertext)).toBeNull();
  });

  test('wrong peer pubkey returns null', () => {
    const alice = generateKeypair();
    const bob = generateKeypair();
    const mallory = generateKeypair();
    const { nonce, ciphertext } = encryptFor(bob.publicKey, alice.secretKey, 'secret');
    expect(decryptFrom(mallory.publicKey, bob.secretKey, nonce, ciphertext)).toBeNull();
  });

  test('wrong recipient secret key returns null', () => {
    const alice = generateKeypair();
    const bob = generateKeypair();
    const mallory = generateKeypair();
    const { nonce, ciphertext } = encryptFor(bob.publicKey, alice.secretKey, 'secret');
    expect(decryptFrom(alice.publicKey, mallory.secretKey, nonce, ciphertext)).toBeNull();
  });

  test('null is returned, not undefined, on tamper (contract for callers)', () => {
    const alice = generateKeypair();
    const bob = generateKeypair();
    const { nonce, ciphertext } = encryptFor(bob.publicKey, alice.secretKey, 'secret');
    const result = decryptFrom(alice.publicKey, bob.secretKey, nonce, flipByte(ciphertext, 0));
    expect(result).toBeNull();
    expect(result).not.toBeUndefined();
  });
});
