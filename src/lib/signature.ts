import crypto from "crypto";

/**
 * Verify Linear webhook signature using HMAC-SHA256.
 * Linear sends the signature in the `linear-signature` header.
 */
export function verifyLinearSignature(
  body: string,
  signature: string,
  secret: string
): boolean {
  try {
    const hmac = crypto.createHmac("sha256", secret);
    hmac.update(body);
    const expectedSignature = hmac.digest("hex");

    const sigBuffer = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expectedSignature);

    if (sigBuffer.length !== expectedBuffer.length) {
      return false;
    }

    return crypto.timingSafeEqual(sigBuffer, expectedBuffer);
  } catch {
    return false;
  }
}
