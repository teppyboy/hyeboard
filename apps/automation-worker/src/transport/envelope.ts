import {
  decryptEnvelope,
  encryptEnvelope,
  type AutomationKeyring,
  type EnvelopeAad,
} from "@hyeboard/automation-protocol";

export class AutomationEnvelopeCodec {
  constructor(
    private readonly keyring: AutomationKeyring,
    private readonly now: () => number = Date.now,
  ) {}

  open<T>(token: string, aad: EnvelopeAad): Promise<T> {
    return decryptEnvelope<T>(token, { keyring: this.keyring, aad, now: this.now() });
  }

  close<T>(payload: T, aad: EnvelopeAad, expiresAt: string): Promise<string> {
    return encryptEnvelope(payload, {
      keyring: this.keyring,
      aad,
      expiresAt,
      issuedAt: new Date(this.now()).toISOString(),
    });
  }
}
