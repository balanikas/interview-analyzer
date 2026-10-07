// Helpers shared by the code that fetches user-supplied links.

import { isIP } from "node:net";

/** An error that maps to an HTTP status in the API response. */
export class HttpError extends Error {
  constructor(message: string, readonly status = 502) { super(message); }
}

export function isPrivateAddress(addr: string): boolean {
  if (isIP(addr) === 4) {
    const [a, b] = addr.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
           (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  const v6 = addr.toLowerCase();
  if (v6.startsWith("::ffff:")) return isPrivateAddress(v6.slice(7));
  return v6 === "::" || v6 === "::1" || v6.startsWith("fc") || v6.startsWith("fd") || v6.startsWith("fe80");
}
