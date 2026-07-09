import type { Team } from "./types";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function nullableStr(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function bool(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function stringRecord(value: unknown): Record<string, string> {
  const raw = asRecord(value);
  if (!raw) return {};
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(raw)) {
    if (typeof item === "string") out[key] = item;
  }
  return out;
}

function normalizeSiliconFolders(value: unknown): Team["silicon_folders"] {
  const raw = asRecord(value);
  if (!raw) return undefined;
  const folders = Array.isArray(raw.folders)
    ? raw.folders.flatMap((item) => {
        const folder = asRecord(item);
        if (!folder) return [];
        const id = str(folder.id);
        if (!id) return [];
        return [{ id, name: str(folder.name, "Folder") }];
      })
    : [];
  return {
    folders,
    assignments: stringRecord(raw.assignments),
  };
}

export function normalizeTeam(value: unknown): Team | null {
  const raw = asRecord(value);
  if (!raw) return null;

  const slug = str(raw.slug, str(raw.team_id));
  const name = str(raw.name, slug);
  const finalSlug = slug || name;
  if (!finalSlug) return null;

  const settings = asRecord(raw.settings);
  const whitelist = asRecord(raw.email_whitelist);

  return {
    ...(raw as Partial<Team>),
    team_id: str(raw.team_id, finalSlug),
    name: name || finalSlug,
    slug: finalSlug,
    team_heads: stringArray(raw.team_heads),
    logo_key: str(raw.logo_key),
    logo_url: nullableStr(raw.logo_url),
    settings: {
      ...(settings ?? {}),
      let_employees_invite: bool(settings?.let_employees_invite),
      verify_carbons: bool(settings?.verify_carbons),
    },
    email_whitelist: {
      domains: stringArray(whitelist?.domains),
      emails: stringArray(whitelist?.emails),
    },
    trust_chart: asRecord(raw.trust_chart) ?? {},
    tags: Array.isArray(raw.tags) ? raw.tags : [],
    notes: str(raw.notes),
    silicon_folders: normalizeSiliconFolders(raw.silicon_folders),
    created_at: str(raw.created_at),
    updated_at: str(raw.updated_at),
  };
}

export function normalizeTeams(value: unknown): Team[] {
  if (!Array.isArray(value)) return [];
  return value.map(normalizeTeam).filter((team): team is Team => team !== null);
}
