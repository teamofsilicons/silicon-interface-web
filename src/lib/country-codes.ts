// Country dial codes for the phone-number flows. Flags are derived from the
// ISO-3166-1 alpha-2 code at render time (regional-indicator symbols), so the
// dataset only stores name + iso2 + dial.

import { TZ_COUNTRY } from "./tz-countries";

export interface Country {
  iso2: string;
  name: string;
  dial: string; // digits only, no leading "+"
}

export const COUNTRY_CODES: Country[] = [
  { iso2: "AF", name: "Afghanistan", dial: "93" },
  { iso2: "AL", name: "Albania", dial: "355" },
  { iso2: "DZ", name: "Algeria", dial: "213" },
  { iso2: "AD", name: "Andorra", dial: "376" },
  { iso2: "AO", name: "Angola", dial: "244" },
  { iso2: "AR", name: "Argentina", dial: "54" },
  { iso2: "AM", name: "Armenia", dial: "374" },
  { iso2: "AU", name: "Australia", dial: "61" },
  { iso2: "AT", name: "Austria", dial: "43" },
  { iso2: "AZ", name: "Azerbaijan", dial: "994" },
  { iso2: "BH", name: "Bahrain", dial: "973" },
  { iso2: "BD", name: "Bangladesh", dial: "880" },
  { iso2: "BB", name: "Barbados", dial: "1" },
  { iso2: "BY", name: "Belarus", dial: "375" },
  { iso2: "BE", name: "Belgium", dial: "32" },
  { iso2: "BZ", name: "Belize", dial: "501" },
  { iso2: "BJ", name: "Benin", dial: "229" },
  { iso2: "BT", name: "Bhutan", dial: "975" },
  { iso2: "BO", name: "Bolivia", dial: "591" },
  { iso2: "BA", name: "Bosnia and Herzegovina", dial: "387" },
  { iso2: "BW", name: "Botswana", dial: "267" },
  { iso2: "BR", name: "Brazil", dial: "55" },
  { iso2: "BN", name: "Brunei", dial: "673" },
  { iso2: "BG", name: "Bulgaria", dial: "359" },
  { iso2: "BF", name: "Burkina Faso", dial: "226" },
  { iso2: "BI", name: "Burundi", dial: "257" },
  { iso2: "KH", name: "Cambodia", dial: "855" },
  { iso2: "CM", name: "Cameroon", dial: "237" },
  { iso2: "CA", name: "Canada", dial: "1" },
  { iso2: "CV", name: "Cape Verde", dial: "238" },
  { iso2: "CF", name: "Central African Republic", dial: "236" },
  { iso2: "TD", name: "Chad", dial: "235" },
  { iso2: "CL", name: "Chile", dial: "56" },
  { iso2: "CN", name: "China", dial: "86" },
  { iso2: "CO", name: "Colombia", dial: "57" },
  { iso2: "KM", name: "Comoros", dial: "269" },
  { iso2: "CG", name: "Congo", dial: "242" },
  { iso2: "CD", name: "Congo (DRC)", dial: "243" },
  { iso2: "CR", name: "Costa Rica", dial: "506" },
  { iso2: "CI", name: "Côte d'Ivoire", dial: "225" },
  { iso2: "HR", name: "Croatia", dial: "385" },
  { iso2: "CU", name: "Cuba", dial: "53" },
  { iso2: "CY", name: "Cyprus", dial: "357" },
  { iso2: "CZ", name: "Czechia", dial: "420" },
  { iso2: "DK", name: "Denmark", dial: "45" },
  { iso2: "DJ", name: "Djibouti", dial: "253" },
  { iso2: "DO", name: "Dominican Republic", dial: "1" },
  { iso2: "EC", name: "Ecuador", dial: "593" },
  { iso2: "EG", name: "Egypt", dial: "20" },
  { iso2: "SV", name: "El Salvador", dial: "503" },
  { iso2: "GQ", name: "Equatorial Guinea", dial: "240" },
  { iso2: "ER", name: "Eritrea", dial: "291" },
  { iso2: "EE", name: "Estonia", dial: "372" },
  { iso2: "ET", name: "Ethiopia", dial: "251" },
  { iso2: "FJ", name: "Fiji", dial: "679" },
  { iso2: "FI", name: "Finland", dial: "358" },
  { iso2: "FR", name: "France", dial: "33" },
  { iso2: "GA", name: "Gabon", dial: "241" },
  { iso2: "GM", name: "Gambia", dial: "220" },
  { iso2: "GE", name: "Georgia", dial: "995" },
  { iso2: "DE", name: "Germany", dial: "49" },
  { iso2: "GH", name: "Ghana", dial: "233" },
  { iso2: "GR", name: "Greece", dial: "30" },
  { iso2: "GT", name: "Guatemala", dial: "502" },
  { iso2: "GN", name: "Guinea", dial: "224" },
  { iso2: "GY", name: "Guyana", dial: "592" },
  { iso2: "HT", name: "Haiti", dial: "509" },
  { iso2: "HN", name: "Honduras", dial: "504" },
  { iso2: "HK", name: "Hong Kong", dial: "852" },
  { iso2: "HU", name: "Hungary", dial: "36" },
  { iso2: "IS", name: "Iceland", dial: "354" },
  { iso2: "IN", name: "India", dial: "91" },
  { iso2: "ID", name: "Indonesia", dial: "62" },
  { iso2: "IR", name: "Iran", dial: "98" },
  { iso2: "IQ", name: "Iraq", dial: "964" },
  { iso2: "IE", name: "Ireland", dial: "353" },
  { iso2: "IL", name: "Israel", dial: "972" },
  { iso2: "IT", name: "Italy", dial: "39" },
  { iso2: "JM", name: "Jamaica", dial: "1" },
  { iso2: "JP", name: "Japan", dial: "81" },
  { iso2: "JO", name: "Jordan", dial: "962" },
  { iso2: "KZ", name: "Kazakhstan", dial: "7" },
  { iso2: "KE", name: "Kenya", dial: "254" },
  { iso2: "KW", name: "Kuwait", dial: "965" },
  { iso2: "KG", name: "Kyrgyzstan", dial: "996" },
  { iso2: "LA", name: "Laos", dial: "856" },
  { iso2: "LV", name: "Latvia", dial: "371" },
  { iso2: "LB", name: "Lebanon", dial: "961" },
  { iso2: "LS", name: "Lesotho", dial: "266" },
  { iso2: "LR", name: "Liberia", dial: "231" },
  { iso2: "LY", name: "Libya", dial: "218" },
  { iso2: "LI", name: "Liechtenstein", dial: "423" },
  { iso2: "LT", name: "Lithuania", dial: "370" },
  { iso2: "LU", name: "Luxembourg", dial: "352" },
  { iso2: "MO", name: "Macao", dial: "853" },
  { iso2: "MG", name: "Madagascar", dial: "261" },
  { iso2: "MW", name: "Malawi", dial: "265" },
  { iso2: "MY", name: "Malaysia", dial: "60" },
  { iso2: "MV", name: "Maldives", dial: "960" },
  { iso2: "ML", name: "Mali", dial: "223" },
  { iso2: "MT", name: "Malta", dial: "356" },
  { iso2: "MR", name: "Mauritania", dial: "222" },
  { iso2: "MU", name: "Mauritius", dial: "230" },
  { iso2: "MX", name: "Mexico", dial: "52" },
  { iso2: "MD", name: "Moldova", dial: "373" },
  { iso2: "MC", name: "Monaco", dial: "377" },
  { iso2: "MN", name: "Mongolia", dial: "976" },
  { iso2: "ME", name: "Montenegro", dial: "382" },
  { iso2: "MA", name: "Morocco", dial: "212" },
  { iso2: "MZ", name: "Mozambique", dial: "258" },
  { iso2: "MM", name: "Myanmar", dial: "95" },
  { iso2: "NA", name: "Namibia", dial: "264" },
  { iso2: "NP", name: "Nepal", dial: "977" },
  { iso2: "NL", name: "Netherlands", dial: "31" },
  { iso2: "NZ", name: "New Zealand", dial: "64" },
  { iso2: "NI", name: "Nicaragua", dial: "505" },
  { iso2: "NE", name: "Niger", dial: "227" },
  { iso2: "NG", name: "Nigeria", dial: "234" },
  { iso2: "KP", name: "North Korea", dial: "850" },
  { iso2: "MK", name: "North Macedonia", dial: "389" },
  { iso2: "NO", name: "Norway", dial: "47" },
  { iso2: "OM", name: "Oman", dial: "968" },
  { iso2: "PK", name: "Pakistan", dial: "92" },
  { iso2: "PS", name: "Palestine", dial: "970" },
  { iso2: "PA", name: "Panama", dial: "507" },
  { iso2: "PG", name: "Papua New Guinea", dial: "675" },
  { iso2: "PY", name: "Paraguay", dial: "595" },
  { iso2: "PE", name: "Peru", dial: "51" },
  { iso2: "PH", name: "Philippines", dial: "63" },
  { iso2: "PL", name: "Poland", dial: "48" },
  { iso2: "PT", name: "Portugal", dial: "351" },
  { iso2: "QA", name: "Qatar", dial: "974" },
  { iso2: "RO", name: "Romania", dial: "40" },
  { iso2: "RU", name: "Russia", dial: "7" },
  { iso2: "RW", name: "Rwanda", dial: "250" },
  { iso2: "SA", name: "Saudi Arabia", dial: "966" },
  { iso2: "SN", name: "Senegal", dial: "221" },
  { iso2: "RS", name: "Serbia", dial: "381" },
  { iso2: "SC", name: "Seychelles", dial: "248" },
  { iso2: "SL", name: "Sierra Leone", dial: "232" },
  { iso2: "SG", name: "Singapore", dial: "65" },
  { iso2: "SK", name: "Slovakia", dial: "421" },
  { iso2: "SI", name: "Slovenia", dial: "386" },
  { iso2: "SO", name: "Somalia", dial: "252" },
  { iso2: "ZA", name: "South Africa", dial: "27" },
  { iso2: "KR", name: "South Korea", dial: "82" },
  { iso2: "SS", name: "South Sudan", dial: "211" },
  { iso2: "ES", name: "Spain", dial: "34" },
  { iso2: "LK", name: "Sri Lanka", dial: "94" },
  { iso2: "SD", name: "Sudan", dial: "249" },
  { iso2: "SE", name: "Sweden", dial: "46" },
  { iso2: "CH", name: "Switzerland", dial: "41" },
  { iso2: "SY", name: "Syria", dial: "963" },
  { iso2: "TW", name: "Taiwan", dial: "886" },
  { iso2: "TJ", name: "Tajikistan", dial: "992" },
  { iso2: "TZ", name: "Tanzania", dial: "255" },
  { iso2: "TH", name: "Thailand", dial: "66" },
  { iso2: "TG", name: "Togo", dial: "228" },
  { iso2: "TT", name: "Trinidad and Tobago", dial: "1" },
  { iso2: "TN", name: "Tunisia", dial: "216" },
  { iso2: "TR", name: "Türkiye", dial: "90" },
  { iso2: "TM", name: "Turkmenistan", dial: "993" },
  { iso2: "UG", name: "Uganda", dial: "256" },
  { iso2: "UA", name: "Ukraine", dial: "380" },
  { iso2: "AE", name: "United Arab Emirates", dial: "971" },
  { iso2: "GB", name: "United Kingdom", dial: "44" },
  { iso2: "US", name: "United States", dial: "1" },
  { iso2: "UY", name: "Uruguay", dial: "598" },
  { iso2: "UZ", name: "Uzbekistan", dial: "998" },
  { iso2: "VE", name: "Venezuela", dial: "58" },
  { iso2: "VN", name: "Vietnam", dial: "84" },
  { iso2: "YE", name: "Yemen", dial: "967" },
  { iso2: "ZM", name: "Zambia", dial: "260" },
  { iso2: "ZW", name: "Zimbabwe", dial: "263" },
];

const BY_ISO = new Map(COUNTRY_CODES.map((c) => [c.iso2, c]));

// Preferred country when a dial code is shared by several countries. Without
// this, a first-match scan over the alphabetically-ordered list resolves "+1"
// to Barbados (BB) rather than the US, and "+7" could land on KZ instead of RU.
// We bias to the most populous / most-likely-typed member so a bare "+1 415…"
// paste keeps the US flag. Keyed by dial string (digits only).
const PREFERRED_BY_DIAL: Record<string, string> = {
  "1": "US",
  "7": "RU",
};

export function findCountry(iso2: string): Country | undefined {
  return BY_ISO.get(iso2.toUpperCase());
}

/** The country to attribute a dial code to, honouring the shared-code bias. */
function countryForDial(dial: string): Country | undefined {
  const preferred = PREFERRED_BY_DIAL[dial];
  if (preferred) {
    const c = BY_ISO.get(preferred);
    if (c) return c;
  }
  return COUNTRY_CODES.find((c) => c.dial === dial);
}

/** Regional-indicator flag emoji from an ISO-3166-1 alpha-2 code. */
export function iso2ToFlag(iso2: string): string {
  const cc = iso2.toUpperCase();
  if (cc.length !== 2) return "🏳️";
  const A = 0x1f1e6;
  return String.fromCodePoint(A + (cc.charCodeAt(0) - 65), A + (cc.charCodeAt(1) - 65));
}

/**
 * Split an E.164 number ("+14155551212") back into a country + local number.
 * Longest-dial-first so multi-digit codes (e.g. +44) beat prefix collisions.
 */
export function parseE164(e164: string): { country: Country; number: string } | null {
  if (!e164 || !e164.startsWith("+")) return null;
  const digits = e164.slice(1).replace(/\D/g, "");
  // Try longest dial codes first so multi-digit codes (e.g. +44) beat shorter
  // prefix collisions. For each matching prefix length, resolve to the
  // preferred country (US over BB for "+1", RU over KZ for "+7") via
  // countryForDial rather than first-in-list.
  const dialLens = Array.from(new Set(COUNTRY_CODES.map((c) => c.dial.length))).sort(
    (a, b) => b - a,
  );
  for (const len of dialLens) {
    const prefix = digits.slice(0, len);
    const c = countryForDial(prefix);
    if (c && digits.startsWith(c.dial)) {
      return { country: c, number: digits.slice(c.dial.length) };
    }
  }
  return null;
}

/**
 * Normalize a pasted phone number against a currently-selected country.
 *
 * Users paste numbers in wildly different shapes, and the naive
 * `+${dial}${typed}` concatenation in the forms double-prefixes or produces
 * invalid E.164:
 *   - Pasting "+1 415 555 1212" while US is selected → "+114155551212" (the
 *     dial code appears twice). We detect a pasted leading "+" / matching
 *     country code and strip it so only the national part remains.
 *   - Pasting a UK "07911 123456" (national trunk "0") → "+44 07911123456",
 *     which is invalid; the trunk "0" must be dropped when an international
 *     code is prepended. We strip a single leading "0".
 *
 * Returns `{ country, number }` where `number` is the local digits to put in
 * the input. If the paste carries its own "+<code>", `country` may switch to
 * match (so pasting a foreign number while US is selected resolves correctly).
 */
export function normalizePhonePaste(
  raw: string,
  current: Country,
): { country: Country; number: string } {
  const trimmed = raw.trim();

  // Case 1: an explicit international number ("+…" or "00…" IDD prefix).
  // Re-derive the country from the pasted code rather than trusting the
  // currently-selected one, then keep just the national remainder.
  const intl = trimmed.startsWith("+")
    ? trimmed
    : /^00\d/.test(trimmed.replace(/[\s()-]/g, ""))
      ? "+" + trimmed.replace(/[\s()-]/g, "").slice(2)
      : null;
  if (intl) {
    const parsed = parseE164(intl);
    if (parsed) return parsed;
    // Unknown code: fall back to stripping a leading "+" so we don't double it.
    return { country: current, number: trimmed.replace(/\D/g, "") };
  }

  // Case 2: bare national digits. The selected country supplies the code.
  let digits = trimmed.replace(/\D/g, "");

  // Case 2a: the paste accidentally includes the current dial code with no "+"
  // (e.g. selected US and pasted "1 415 555 1212", or selected UK and pasted
  // "44 7911 123456"). Strip a single leading copy — but only when the leftover
  // is still a plausible national number (>= 6 digits). This guards against
  // mangling a legitimately leading-with-dial-digit national number (a real US
  // number can't start with country code 1 anyway, but other regions' leading
  // digits could coincide with their own code).
  if (
    current.dial &&
    digits.startsWith(current.dial) &&
    digits.length - current.dial.length >= 6
  ) {
    digits = digits.slice(current.dial.length);
  }

  // Case 2b: drop a single national trunk "0" (UK/DE/FR/… write local numbers
  // with a leading 0 that is omitted in international form).
  if (digits.startsWith("0")) digits = digits.replace(/^0+/, "");

  return { country: current, number: digits };
}

/**
 * Interpret a phone input while it is being typed. National numbers are left
 * exactly as entered, but an explicit international prefix immediately moves
 * the dial-code selector to the matching country. Keeping an incomplete "+9"
 * intact is important: the next keystroke can turn it into India's "+91".
 */
export function normalizePhoneInput(
  raw: string,
  current: Country,
): { country: Country; number: string } {
  const compact = raw.trim().replace(/[\s()-]/g, "");
  const explicitInternational = raw.trim().startsWith("+") || /^00\d/.test(compact);
  if (!explicitInternational) return { country: current, number: raw };

  const candidate = raw.trim().startsWith("+")
    ? raw.trim()
    : `+${compact.slice(2)}`;
  return parseE164(candidate) ?? { country: current, number: raw };
}

/** Resolve the first supported region embedded in a browser language list. */
export function countryIso2FromLanguages(languages: readonly string[]): string | null {
  for (const language of languages) {
    const match = /[-_]([A-Za-z]{2})(?:[-_]|$)/.exec(language ?? "");
    if (!match) continue;
    const iso2 = match[1].toUpperCase();
    if (BY_ISO.has(iso2)) return iso2;
  }
  return null;
}

/** Resolve a supported country from the browser's IANA timezone. */
export function countryIso2FromTimeZone(timeZone: string): string | null {
  const iso2 = TZ_COUNTRY[timeZone]?.toUpperCase() ?? "";
  return BY_ISO.has(iso2) ? iso2 : null;
}

/**
 * Best-effort country guess from the browser locale region (e.g. "en-GB" → GB).
 * Privacy-friendly (no network); falls back to US.
 */
export function guessCountryIso2(): string {
  if (typeof navigator === "undefined") return "US";
  const langs = [navigator.language, ...(navigator.languages ?? [])];
  const localeCountry = countryIso2FromLanguages(langs);
  if (localeCountry) return localeCountry;
  try {
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone ?? "";
    return countryIso2FromTimeZone(timeZone) ?? "US";
  } catch {
    return "US";
  }
}
