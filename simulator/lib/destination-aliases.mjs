const norm = value => String(value ?? '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const country = value => ({italia:'it',italy:'it'})[norm(value)] ?? norm(value);

// No preconfigured operator-specific aliases are distributed.
export function destinationAliasFor() { return null; }

export function resolveDestinationAliasCandidate(alias, candidates) {
  if (!alias || !Array.isArray(candidates)) return null;
  const matches = candidates.filter(candidate =>
    candidate.osm_id === alias.osmId && candidate.osm_type === alias.osmType &&
    candidate.osm_key === alias.osmKey && candidate.osm_value === alias.osmValue &&
    norm(candidate.name) === norm(alias.canonicalName) && norm(candidate.city) === norm(alias.city) &&
    norm(candidate.street) === norm(alias.street) && country(candidate.country) === 'it'
  );
  if (matches.length !== 1) return null;
  return {
    ...matches[0],
    matched_alias: alias.label,
    identity_sources: { official: alias.officialSource, openstreetmap: alias.mapSource },
    house_number_verified: false,
    entrance_verified: false
  };
}
