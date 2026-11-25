/**
 * Small deny-list of common passwords that satisfy the 12-character minimum (ADR-0009 §3), drawn from
 * well-known breach-corpus top lists, plus simple structural checks (one repeated character, keyboard and
 * digit runs). Not a substitute for a breach-corpus check; it blocks the obvious choices.
 */
const COMMON = new Set(
  [
    '123456789012',
    '1234567890123',
    '12345678901234',
    '123456789000',
    '111111111111',
    '000000000000',
    '123123123123',
    '121212121212',
    '987654321098',
    'qwertyuiop12',
    'qwertyuiopas',
    'qwertyuiopasdf',
    'qwertyuiopasdfgh',
    'qwerty123456',
    'qwerty1234567',
    '1q2w3e4r5t6y',
    '1qaz2wsx3edc',
    '1qaz2wsx3edc4rfv',
    'zaq12wsxcde3',
    'asdfghjkl123',
    "asdfghjkl;'",
    'zxcvbnm12345',
    'password1234',
    'password12345',
    'password123456',
    'password123!',
    'passw0rd1234',
    'p@ssw0rd1234',
    'p@ssword1234',
    'passwordpassword',
    'mypassword123',
    'adminadmin123',
    'administrator',
    'administrator1',
    'admin1234567',
    'admin12345678',
    'rootroot1234',
    'changeme1234',
    'changemenow!',
    'letmein12345',
    'letmeinplease',
    'welcome12345',
    'welcome123456',
    'welcometothejungle',
    'iloveyou1234',
    'iloveyouforever',
    'trustno11234',
    'sunshine1234',
    'princess1234',
    'football1234',
    'baseball1234',
    'superman1234',
    'starwars1234',
    'monkey123456',
    'dragon123456',
    'master123456',
    'qwertyqwerty',
    'abcdefghijkl',
    'abcdefghijklm',
    'abc123abc123',
    'abcd1234abcd',
    'abcdefgh1234',
    'aaaaaaaaaaaa',
    'correcthorsebatterystaple',
    'correct horse battery staple',
    'thequickbrownfox',
    'thequickbrownfoxjumpsoverthelazydog',
    'internet1234',
    'computer1234',
    'qazwsxedcrfv',
    'q1w2e3r4t5y6',
    'a1b2c3d4e5f6',
    'remyral123456',
    'remanaagentcluster',
    'remyralagentcluster',
    'remana-agent-cluster',
  ].map((p) => p.toLowerCase()),
);

const SEQUENCES = [
  '0123456789012345678901234567890',
  'abcdefghijklmnopqrstuvwxyz',
  'qwertyuiopasdfghjklzxcvbnm',
];

export function isCommonPassword(password: string): boolean {
  const p = password.toLowerCase();
  if (COMMON.has(p)) return true;
  if (new Set(p).size <= 2) return true; // "aaaaaaaaaaaa", "abababababab"
  for (const seq of SEQUENCES) {
    if (seq.includes(p)) return true;
    const reversed = Array.from(seq).reverse().join('');
    if (reversed.includes(p)) return true;
  }
  return false;
}
