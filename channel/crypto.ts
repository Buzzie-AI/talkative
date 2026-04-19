import nacl from 'tweetnacl';
import naclUtil from 'tweetnacl-util';

export interface KeyPair {
  publicKey: string;
  secretKey: string;
}

export interface EncryptedMessage {
  nonce: string;
  ciphertext: string;
}

export function generateKeypair(): KeyPair {
  const pair = nacl.box.keyPair();
  return {
    publicKey: naclUtil.encodeBase64(pair.publicKey),
    secretKey: naclUtil.encodeBase64(pair.secretKey),
  };
}

export function encryptFor(
  peerPubkeyB64: string,
  mySecretKeyB64: string,
  plaintext: string,
): EncryptedMessage {
  const peerPubkey = naclUtil.decodeBase64(peerPubkeyB64);
  const mySecret = naclUtil.decodeBase64(mySecretKeyB64);
  const nonce = nacl.randomBytes(nacl.box.nonceLength);
  const plainBytes = naclUtil.decodeUTF8(plaintext);
  const cipher = nacl.box(plainBytes, nonce, peerPubkey, mySecret);
  return {
    nonce: naclUtil.encodeBase64(nonce),
    ciphertext: naclUtil.encodeBase64(cipher),
  };
}

export function decryptFrom(
  peerPubkeyB64: string,
  mySecretKeyB64: string,
  nonceB64: string,
  ciphertextB64: string,
): string | null {
  const peerPubkey = naclUtil.decodeBase64(peerPubkeyB64);
  const mySecret = naclUtil.decodeBase64(mySecretKeyB64);
  const nonce = naclUtil.decodeBase64(nonceB64);
  const cipher = naclUtil.decodeBase64(ciphertextB64);
  const plain = nacl.box.open(cipher, nonce, peerPubkey, mySecret);
  if (!plain) return null;
  return naclUtil.encodeUTF8(plain);
}
