/* Prix TCGplayer (marché américain, en dollars) : relie chaque impression à son produit TCGplayer (lien, prix).
   Données lues sur TCGCSV (tcgcsv.com), copie quotidienne publique des données de TCGplayer, sans lien officiel avec
   TCGplayer. Lancé chaque nuit par .github/workflows/prix.yml avec les prix Cardmarket (résultat sur la branche
   « prix ») ; catalogue lu dans prix/catalogue/, comme sync-cardmarket.mjs. */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const CATEGORY = 92; // « Cyberpunk TCG » sur TCGplayer
const BASE = 'https://tcgcsv.com/tcgplayer';

const load = (file) => JSON.parse(readFileSync(new URL(`./catalogue/${file}`, import.meta.url)));
const values = (data) => (Array.isArray(data) ? data : Object.values(data));

async function download(url, json = true) {
  // TCGCSV refuse les requêtes sans User-Agent : on dit qui on est.
  const headers = { 'User-Agent': 'CyberCardex-prix (https://github.com/CyberCardex/cybercardex-data)' };
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`${url} : HTTP ${response.status}`);
  return json ? response.json() : response.text();
}

const norm = (text) =>
  text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\bseason\s*/g, 's')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/** Numéro comparable : « β001 », « B001 », « 001 » et « 1 » donnent « 1 ». */
const number = (text) => (text ?? '').replace(/^[^0-9]*/, '').replace(/^0+(?=\d)/, '');

const cards = Object.fromEntries(values(load('cards.json')).map((card) => [card.id, card]));
const printings = values(load('printings.json'));
const sets = values(load('sets.json'));

const cardName = (printing) => {
  const card = cards[printing.cardId];
  return norm(card.subtitle ? `${card.name} ${card.subtitle}` : card.name);
};
/** Noms mal orthographiés sur TCGplayer → nom officiel. */
const ALIASES = { 'tetratonic rippler': 'tetratronic rippler' };

// « Adam Smasher - Ender of Legends (Epic) » → « adam smasher ender of legends » : seulement la parenthèse finale
// (« (Don't Fear) The Reaper » garde la sienne).
const productName = (product) => {
  const name = norm(product.name.replace(/\s*\([^)]*\)\s*$/, ''));
  return ALIASES[name] ?? name;
};

const updatedAt = new Date((await download('https://tcgcsv.com/last-updated.txt', false)).trim()).toISOString();
const groups = (await download(`${BASE}/${CATEGORY}/groups`)).results;

const links = {};
const report = [];

for (const group of groups) {
  // Groupe ↔ série : « Welcome to Night City - Beta » = nom + édition ; « Night City Brawl Season 1 » = « … S1 ».
  const key = norm(group.name);
  const set = sets.find((s) => key === norm(s.name) || key === norm(`${s.name} ${s.edition}`));
  const [{ results: products }, { results: priceRows }] = await Promise.all([
    download(`${BASE}/${CATEGORY}/${group.groupId}/products`),
    download(`${BASE}/${CATEGORY}/${group.groupId}/prices`),
  ]);
  const singles = products.filter((p) => p.extendedData?.some((e) => e.name === 'Number'));
  if (!set) {
    if (singles.length) report.push(`  groupe ${group.groupId} « ${group.name} » (${singles.length} cartes) : aucune série locale`);
    continue;
  }
  const local = printings.filter((p) => p.setId === set.id && p.language === 'EN');
  const prices = new Map();
  for (const row of priceRows) prices.set(`${row.productId}|${row.subTypeName}`, row);
  let linked = 0;
  for (const product of singles) {
    // « V - Streetkid (b) » numérotée « 005 » sur TCGplayer : la lettre du nom complète le numéro (005b).
    const letter = /\(([a-z])\)\s*$/i.exec(product.name)?.[1]?.toLowerCase() ?? '';
    const raw = number(product.extendedData.find((e) => e.name === 'Number').value);
    const num = letter && !raw.endsWith(letter) ? `${raw.replace(/[a-z]$/, '')}${letter}` : raw;
    const name = productName(product);
    // Même numéro ET même nom (début du nom : TCGplayer ajoute parfois « (007) ») ; sinon le nom seul s'il est unique.
    const sameName = (p) => cardName(p) === name || cardName(p).startsWith(name) || name.startsWith(cardName(p));
    let matches = local.filter((p) => number(p.number) === num && sameName(p));
    if (!matches.length) {
      const byName = local.filter(sameName);
      if (new Set(byName.map((p) => p.number)).size === 1) matches = byName;
    }
    if (!matches.length) {
      report.push(`  ? ${group.name} #${num} « ${product.name} » : pas de carte locale`);
      continue;
    }
    const normal = prices.get(`${product.productId}|Normal`), foil = prices.get(`${product.productId}|Foil`);
    const entry = {
      id: product.productId,
      market: normal?.marketPrice ?? undefined,
      low: normal?.lowPrice ?? undefined,
      marketFoil: foil?.marketPrice ?? undefined,
      lowFoil: foil?.lowPrice ?? undefined,
    };
    // Toutes les langues et finitions de la version : TCGplayer vend la carte anglaise, foil ou non sur la même fiche.
    for (const printing of matches) {
      for (const variant of printings.filter((p) => p.variantKey === printing.variantKey)) {
        links[variant.id] = entry;
      }
    }
    linked++;
  }
  report.push(`  ${set.id} ← groupe ${group.groupId} : ${linked} / ${singles.length} cartes reliées`);
}

// Garde-fous (robot de nuit) : pas de prix plus anciens ni de chute brutale.
const outIndex = process.argv.indexOf('--out');
const output = outIndex > 0 ? path.resolve(process.argv[outIndex + 1]) : path.resolve('tcgplayer.json');
let previous;
try {
  previous = JSON.parse(readFileSync(output));
} catch {
  previous = undefined;
}
const linkedCount = Object.keys(links).length;
const previousCount = previous ? Object.keys(previous.products ?? {}).length : 0;
const problems = [
  previous && Date.parse(updatedAt) < Date.parse(previous.updatedAt) ? `prix du ${updatedAt} plus anciens que ceux publiés (${previous.updatedAt})` : '',
  linkedCount < previousCount * 0.9 ? `${linkedCount} impressions reliées au lieu de ${previousCount} (chute de plus de 10 %)` : '',
  linkedCount === 0 ? 'aucune impression reliée' : '',
].filter(Boolean);
if (problems.length > 0) {
  console.error(report.join('\n'));
  console.error(`✗ Rien n'est écrit :\n  ${problems.join('\n  ')}`);
  process.exit(1);
}

writeFileSync(output, `${JSON.stringify({ updatedAt, source: 'TCGplayer via TCGCSV', products: links }, null, 2)}\n`);
console.log(report.join('\n'));
console.log(`✓ ${path.relative(process.cwd(), output)} : ${linkedCount} impressions reliées (prix du ${updatedAt.slice(0, 10)})`);
