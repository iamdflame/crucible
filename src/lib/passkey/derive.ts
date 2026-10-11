/**
 * A wallet key from a passkey, derived where the passkey lives and nowhere else.
 *
 * WebAuthn's PRF extension lets a passkey answer a fixed question with 32
 * bytes only it can produce, after Face ID, a fingerprint or the device PIN.
 * The same passkey, synced through iCloud Keychain or Google Password
 * Manager, gives the same 32 bytes on every device, so the wallet comes back
 * wherever the passkey does. Those bytes are stretched with HKDF-SHA256 into a
 * secp256k1 private key. Nothing is stored: not the bytes, not the key. MANDATE
 * never sees either. Pure apart from WebCrypto, so the derivation is tested.
 */

import { bytesToHex, hexToBytes, keccak256, stringToBytes, type Hex } from "viem";

/** The question every MANDATE passkey wallet is asked. Fixed forever: changing it would lose every wallet. */
export const PRF_SALT: Uint8Array = hexToBytes(keccak256(stringToBytes("mandatemarkets.com passkey wallet, v1")));

const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

/** HKDF-SHA256 from the passkey's PRF output to a valid secp256k1 private key; a value outside the curve's range is derived again with the next counter. */
export async function keyFromPrf(prf: Uint8Array): Promise<Hex> {
  if (prf.length < 32) throw new Error("the passkey's PRF output is too short");
  const subtle = globalThis.crypto.subtle;
  const ikm = await subtle.importKey("raw", new Uint8Array(prf), "HKDF", false, ["deriveBits"]);
  for (let counter = 0; counter < 8; counter++) {
    const bits = await subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(stringToBytes("MANDATE wallet")), info: new Uint8Array(stringToBytes(`secp256k1 private key ${counter}`)) },
      ikm,
      256,
    );
    const key = bytesToHex(new Uint8Array(bits));
    const k = BigInt(key);
    if (k > 0n && k < N) return key;
  }
  throw new Error("no valid key could be derived");
}
