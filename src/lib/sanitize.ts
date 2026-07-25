// FAT32-safe title sanitisation — here it keeps OPL-friendly filenames.
import assert from 'node:assert/strict';

// strip \ / : * ? " < > | ; collapse whitespace to single spaces;
// trim trailing dots and spaces; cap at 100 chars.
export function sanitizeTitle(s: string): string {
  return s
    .replace(/[\\/:*?"<>|]/g, '') // strip forbidden FAT32 chars
    .replace(/\s+/g, ' ') // collapse all whitespace runs to one space
    .trim() // drop leading/trailing spaces
    .replace(/[. ]+$/, '') // trim trailing dots and spaces
    .slice(0, 100) // cap length
    .replace(/[. ]+$/, ''); // re-trim in case the cap left a trailing dot/space
}

// Self-check: only runs when this file is executed directly (`node sanitize.js`).
if (import.meta.url === `file://${process.argv[1]}`) {
  assert.equal(sanitizeTitle('Mario: Kart / Wii'), 'Mario Kart Wii');
  assert.equal(sanitizeTitle('a\\b/c:d*e?f"g<h>i|j'), 'abcdefghij');
  assert.equal(sanitizeTitle('Wii Sports...   '), 'Wii Sports');
  assert.equal(sanitizeTitle('tabs\tand\nnewlines'), 'tabs and newlines');
  assert.equal(sanitizeTitle('  padded  '), 'padded');
  assert.equal(sanitizeTitle('x'.repeat(150)).length, 100);
  assert.equal(sanitizeTitle('.'.repeat(150)), ''); // all dots -> empty after trim
  console.log('sanitize self-check ok');
}
