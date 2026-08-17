/**
 * Reads one named cookie's value out of a raw Cookie request header.
 * Hand-rolled rather than adding the `cookie-parser` dependency: setting a
 * cookie needs no library at all (res.cookie(...) is built into Express
 * and only serializes an outgoing Set-Cookie header), and reading back one
 * specific, known cookie name is the loop below. cookie-parser's other
 * features — signed cookies, parsing every cookie into req.cookies,
 * JSON-cookie support — go unused here: the unlock grant is already a
 * signed JWT (see src/services/unlockTokenService.ts), so a second signing
 * mechanism on top would be redundant. See Notes.md, "Phase 7: The Public
 * Redirect" / "Why not cookie-parser."
 */
export function readCookie(cookieHeader: string | undefined, name: string): string | undefined {
  if (!cookieHeader) return undefined;

  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }

  return undefined;
}
