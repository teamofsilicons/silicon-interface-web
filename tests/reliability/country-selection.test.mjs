import assert from "node:assert/strict";
import test from "node:test";

import {
  countryIso2FromLanguages,
  countryIso2FromTimeZone,
  findCountry,
  normalizePhoneInput,
} from "../../src/lib/country-codes.ts";
import { countryIso2FromHeaders } from "../../src/lib/location-country.ts";

test("explicit international phone input selects its country while typing", () => {
  const us = findCountry("US");
  const india = normalizePhoneInput("+91 98765 43210", us);
  assert.equal(india.country.iso2, "IN");
  assert.equal(india.number, "9876543210");

  const incomplete = normalizePhoneInput("+9", us);
  assert.equal(incomplete.country.iso2, "US");
  assert.equal(incomplete.number, "+9");

  const national = normalizePhoneInput("07911 123456", findCountry("GB"));
  assert.equal(national.country.iso2, "GB");
  assert.equal(national.number, "07911 123456");
});

test("locale and timezone provide privacy-safe location fallbacks", () => {
  assert.equal(countryIso2FromLanguages(["en", "hi-IN"]), "IN");
  assert.equal(countryIso2FromLanguages(["en"]), null);
  assert.equal(countryIso2FromTimeZone("Asia/Kolkata"), "IN");
  assert.equal(countryIso2FromTimeZone("Etc/UTC"), null);
});

test("deployment geolocation headers select only supported countries", () => {
  assert.equal(countryIso2FromHeaders(new Headers({ "x-vercel-ip-country": "in" })), "IN");
  assert.equal(countryIso2FromHeaders(new Headers({ "cf-ipcountry": "UK" })), "GB");
  assert.equal(countryIso2FromHeaders(new Headers({ "x-vercel-ip-country": "XX" })), null);
});
