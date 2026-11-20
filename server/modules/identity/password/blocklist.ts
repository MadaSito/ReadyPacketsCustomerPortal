/**
 * Bundled blocked-password data (offline, no external breach API). Two layers:
 *  - COMMON_PASSWORDS: frequent leaked passwords and long, well-known phrases (exact match, case/space-insensitive).
 *  - COMMON_BASE_WORDS: words that carry little entropy; they are stripped before the "remaining strength" check.
 * A compromised-password (k-anonymity) provider is an optional, disabled-by-default target (see VERIFICATION.md).
 */
export const COMMON_PASSWORDS: readonly string[] = [
  "123456", "password", "12345678", "qwerty", "123456789", "12345", "1234", "111111", "1234567", "dragon",
  "123123", "baseball", "abc123", "football", "monkey", "letmein", "696969", "shadow", "master", "666666",
  "qwertyuiop", "123321", "mustang", "1234567890", "michael", "654321", "superman", "1qaz2wsx", "7777777",
  "121212", "000000", "qazwsx", "123qwe", "killer", "trustno1", "jordan", "jennifer", "zxcvbnm", "asdfgh",
  "hunter", "buster", "soccer", "harley", "batman", "andrew", "tigger", "sunshine", "iloveyou", "2000",
  "charlie", "robert", "thomas", "hockey", "ranger", "daniel", "starwars", "klaster", "112233", "george",
  "computer", "michelle", "jessica", "pepper", "1111", "zxcvbn", "555555", "11111111", "131313", "freedom",
  "777777", "pass", "maggie", "159753", "aaaaaa", "ginger", "princess", "joshua", "cheese", "amanda",
  "summer", "love", "ashley", "nicole", "chelsea", "biteme", "matthew", "access", "yankees", "987654321",
  "dallas", "austin", "thunder", "taylor", "matrix", "welcome", "welcome1", "password1", "password123",
  "admin", "admin123", "administrator", "root", "toor", "changeme", "default", "guest", "login", "passw0rd",
  "p@ssw0rd", "p@ssword", "qwerty123", "1q2w3e4r", "1q2w3e4r5t", "zaq12wsx", "q1w2e3r4t5y6", "iloveyou1",
  "secret", "letmein1", "football1", "monkey1", "abcd1234", "abcdef", "abcdefg", "abcdefgh", "qwertyui",
  "passwordpassword", "password12345678", "passwordpassword1", "1234567890123456", "123456789012345",
  "12345678901234567890", "qwertyuiopasdfgh", "qwertyuiopasdfghjkl", "qwertyuiopasdfghjklzxcvbnm",
  "1q2w3e4r5t6y7u8i9o0p", "1qaz2wsx3edc4rfv", "zaq1xsw2cde3vfr4", "iloveyouiloveyou", "letmeinletmein",
  "welcomewelcome", "abcdefghijklmnop", "abcdefghijklmnopqrstuvwxyz", "thequickbrownfox",
  "thequickbrownfoxjumpsoverthelazydog", "correcthorsebatterystaple", "correct horse battery staple",
  "maythefourthbewithyou", "maytheforcebewithyou", "trustno1trustno1", "changemechangeme", "adminadminadmin",
  "administrator123", "passwordispassword", "mypasswordismypassword", "thisismypassword", "thisisapassword",
  "ilovemyfamily", "ilovemymom", "ilovemydog", "ilovemycat", "jesusismysavior", "godisgood123",
  "letmein123456789", "qwerty1234567890", "asdfghjklasdfghjkl", "zxcvbnmzxcvbnm", "11111111111111111",
  "000000000000000", "999999999999999", "aaaaaaaaaaaaaaa", "password1234567", "welcome123456789",
  "summer2024summer", "winter2024winter", "spring2025spring", "autumn2025autumn", "readypackets",
  "readypackets123", "readypackets2026",
];

export const COMMON_BASE_WORDS: readonly string[] = [
  "password", "passw0rd", "p@ssw0rd", "p@ssword", "qwerty", "azerty", "letmein", "welcome", "admin",
  "administrator", "iloveyou", "monkey", "dragon", "master", "sunshine", "princess", "football", "baseball",
  "secret", "changeme", "default", "login", "trustno", "starwars", "superman", "batman", "abc", "asdf",
  "zxcv", "summer", "winter", "spring", "autumn", "january", "december", "user", "guest", "test",
];

/** Keyboard rows and alphabet/digit runs used to detect sequence-only passwords. */
export const SEQUENCES: readonly string[] = [
  "abcdefghijklmnopqrstuvwxyz",
  "01234567890",
  "qwertyuiop",
  "asdfghjkl",
  "zxcvbnm",
  "1qaz2wsx3edc4rfv5tgb6yhn7ujm8ik9ol0p",
  "zaq1xsw2cde3vfr4bgt5nhy6mju7",
];
