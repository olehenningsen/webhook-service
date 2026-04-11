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
  const hmac = crypto.createHmac("sha256", secret);
  hmac.update(body);
  const expectedSignature = hmac.digest("hex");

  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expectedSignature)
  );
}
