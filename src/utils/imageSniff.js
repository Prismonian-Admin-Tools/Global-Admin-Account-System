'use strict';

// A client-supplied Content-Type is just a string the client chose to
// send — trusting it alone (as both upload routes used to) means any
// file can be relabeled as an allowed image type. This checks the
// bytes actually on disk against each format's real signature instead.
// SVG is deliberately not in here: it's XML, "sniffing" it doesn't
// prove it's inert, and it's the one image format that can carry a
// <script> a browser will execute if the file is ever opened directly
// — see ALLOWED_LOGO_TYPES / ALLOWED_AVATAR_TYPES, neither of which
// accept image/svg+xml.
const SIGNATURES = {
  'image/png': (buf) => buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/jpeg': (buf) => buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff,
  'image/webp': (buf) => buf.length >= 12 && buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP',
};

/** True only if the buffer's actual magic bytes match the claimed (and allowed) MIME type. */
function matchesImageType(buffer, claimedMimeType) {
  const check = SIGNATURES[claimedMimeType];
  return !!check && check(buffer);
}

module.exports = { matchesImageType };
