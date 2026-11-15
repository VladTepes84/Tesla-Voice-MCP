const norm = value => String(value ?? '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const locality = c => c.osm_key === 'place' && ['city','town','village','municipality'].includes(c.osm_value);
const administrative=value=>({italia:'it',italy:'it',it:'it',svizzera:'ch',switzerland:'ch',schweiz:'ch',suisse:'ch',ch:'ch',francia:'fr',france:'fr',fr:'fr',germania:'de',germany:'de',deutschland:'de',de:'de'})[norm(value)]??norm(value);
const meaningful=s=>norm(s).split(' ').filter(t=>t&&!['il','la','lo','gli','le','di','del','della','dei','delle','a','in','presso','the','of'].includes(t));
const canonicalToken=token=>administrative(token);
const addressClause=value=>/^(?:via|viale|piazza|corso|strada|largo|vicolo|passaggio|piazzale|lungo|contrada)\b/.test(norm(value));
// Do not rewrite user-provided destination text.
export function normalizeSpeechDestinationQuery(query) { return { query, correction: null }; }
export function streetQueryWithoutHouseNumber(query) {
  if (typeof query !== 'string') return null;
  const clauses=query.split(',').map(part=>part.trim());
  if(!clauses.length||!addressClause(clauses[0]))return null;
  const withoutHouse=clauses[0].replace(/\s+\d+[a-z]?(?:\/\d+)?$/iu,'').trim();
  if(withoutHouse===clauses[0]||meaningful(withoutHouse).length<2)return null;
  return [withoutHouse,...clauses.slice(1)].filter(Boolean).join(', ');
}
export function resolveDestinationCandidates(query, candidates) {
  const unique = [];
  for (const candidate of candidates) {
    const duplicate = unique.some(other => {
      if (candidate.osm_id && candidate.osm_type && other.osm_id && other.osm_type) return candidate.osm_id===other.osm_id&&candidate.osm_type===other.osm_type;
      const same = ['name','city','country','state','district'].every(key => norm(candidate[key]) === norm(other[key]));
      const veryNear = Math.hypot(candidate.lat - other.lat, (candidate.lon - other.lon) * Math.cos(candidate.lat*Math.PI/180)) < 0.002;
      return same && norm(candidate.name) && veryNear && (locality(candidate) === locality(other));
    });
    if (!duplicate) unique.push(candidate);
  }
  const [name, ...qualifiers] = query.split(',').map(norm);
  const exact = unique.filter(c => locality(c) && norm(c.name) === name && qualifiers.every(q =>
    ['city','country','state','district'].some(key => administrative(c[key]) === administrative(q))));
  // Exact municipality plus supplied administrative qualifiers may exclude POIs,
  // never a second genuinely distinct municipality with the same name.
  if(exact.length===1)return exact;
  // Match every meaningful query token against mapped name/address metadata.
  // Comma clauses may contain either administrative qualifiers or a street
  // address; requiring every clause to equal a city used to discard valid POIs.
  return unique.filter(c=>{
    const adminQualifiers=qualifiers.filter(part=>!addressClause(part));
    if(!adminQualifiers.every(part=>['city','country','state','district'].some(k=>administrative(c[k])===administrative(part))))return false;
    const known=new Set(meaningful([c.name,c.display_name,c.brand,c.operator,c.city,c.country,c.state,c.district,c.street,c.house_number,c.postcode].join(' ')).map(canonicalToken));
    return meaningful(query).map(canonicalToken).every(token=>known.has(token));
  });
}
