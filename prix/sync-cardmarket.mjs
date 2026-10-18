/* Prix du jour : relie chaque impression à son produit Cardmarket (lien, prix). Lancé chaque nuit par
   .github/workflows/prix.yml (résultat sur la branche « prix ») ; catalogue lu dans prix/catalogue/, recopié depuis
   catalog/data du projet de l'app à chaque publication (tool/publish-set.cjs). */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const GAME = 23;
const BASE = 'https://downloads.s3.cardmarket.com/productCatalog';

const load = (file) => JSON.parse(readFileSync(new URL(`./catalogue/${file}`, import.meta.url)));
const values = (data) => (Array.isArray(data) ? data : Object.values(data));

async function download(path) {
  const response = await fetch(`${BASE}/${path}`);
  if (!response.ok) {
    throw new Error(`${path} : HTTP ${response.status}`);
  }
  return response.json();
}

/** Noms mal orthographiés sur Cardmarket → nom officiel. */
const ALIASES = {
  'tetratonic rippler': 'tetratronic rippler',
};

/** Extensions Cardmarket absentes de l'API (rien à relier). */
const IGNORED = {};

/** Correspondances vérifiées à la main, quand le nom ne suffit pas (impression → produit). */
const MANUAL = {
  // Rebecca « Having a Moment » Promo 005 (la jaune) ; la 007 n'a pas encore de fiche à part.
  '71a35836-e604-4d98-ab56-58bfb4581033': 904772,
};

const norm = (text) => {
  const key = text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  return ALIASES[key] ?? key;
};

const byNumber = (a, b) => a.number.localeCompare(b.number, undefined, { numeric: true });

const cards = Object.fromEntries(values(load('cards.json')).map((card) => [card.id, card]));
const printings = values(load('printings.json'));
const sets = values(load('sets.json'));

const cardName = (printing) => {
  const card = cards[printing.cardId];
  return norm(card.subtitle ? `${card.name} ${card.subtitle}` : card.name);
};

const [{ products }, { priceGuides, createdAt }] = await Promise.all([
  download(`productList/products_singles_${GAME}.json`),
  download(`priceGuide/price_guide_${GAME}.json`),
]);
const prices = new Map(priceGuides.map((guide) => [guide.idProduct, guide]));

// Impressions EN de chaque série, dans l'ordre des numéros.
const localSets = sets.map((set) => ({
  set,
  printings: printings.filter((p) => p.setId === set.id && p.language === 'EN').sort(byNumber),
}));

const expansions = new Map();
for (const product of products) {
  if (!expansions.has(product.idExpansion)) {
    expansions.set(product.idExpansion, []);
  }
  expansions.get(product.idExpansion).push(product);
}

const links = {};
const report = [];

/** Relie une impression (toutes ses langues) à un produit, avec ses prix. */
function link(printing, idProduct) {
  const guide = prices.get(idProduct);
  for (const variant of printings.filter((p) => p.variantKey === printing.variantKey)) {
    links[variant.id] = {
      id: idProduct,
      ...(guide && {
        trend: guide.trend ?? undefined,
        low: guide.low ?? undefined,
        trendFoil: guide['trend-foil'] || undefined,
        lowFoil: guide['low-foil'] ?? undefined,
      }),
    };
  }
}

// Extension ↔ série : paires les plus ressemblantes d'abord, Beta à égalité.
const pairs = [];
for (const [idExpansion, list] of expansions) {
  list.sort((a, b) => a.idProduct - b.idProduct);
  const names = new Set(list.map((product) => norm(product.name)));
  for (const entry of localSets) {
    const shared = entry.printings.filter((p) => names.has(cardName(p))).length;
    const score = shared / Math.max(list.length, entry.printings.length);
    if (score >= 0.5) {
      pairs.push({ idExpansion, list, entry, score });
    }
  }
}
pairs.sort(
  (a, b) =>
    b.score - a.score || Number(/beta/.test(b.entry.set.id)) - Number(/beta/.test(a.entry.set.id)),
);

const usedExpansions = new Set();
const usedSets = new Set();
for (const { idExpansion, list, entry } of pairs) {
  if (usedExpansions.has(idExpansion) || usedSets.has(entry.set.id)) {
    continue;
  }
  usedExpansions.add(idExpansion);
  usedSets.add(entry.set.id);

  let linked = 0;
  const groups = new Map();
  for (const product of list) {
    const key = norm(product.name);
    groups.set(key, [...(groups.get(key) ?? []), product]);
  }
  for (const [name, group] of groups) {
    const locals = entry.printings.filter((p) => cardName(p) === name);
    if (locals.length !== group.length) {
      continue; // Versions en nombre différent : correspondance incertaine.
    }
    locals.forEach((printing, index) => {
      link(printing, group[index].idProduct);
      linked++;
    });
  }
  report.push(
    `  ${entry.set.id} ← extension ${idExpansion} : ${linked} / ${list.length} produits reliés`,
  );
}
for (const [printingId, idProduct] of Object.entries(MANUAL)) {
  const printing = printings.find((p) => p.id === printingId);
  if (printing && !links[printingId] && products.some((p) => p.idProduct === idProduct)) {
    link(printing, idProduct);
    report.push(`  correspondance manuelle : ${cardName(printing)} ${printing.number}`);
  }
}
for (const [idExpansion, list] of expansions) {
  if (!usedExpansions.has(idExpansion)) {
    report.push(
      IGNORED[idExpansion]
        ? `  extension ${idExpansion} (${IGNORED[idExpansion]}) : absente de l'API, ignorée`
        : `  extension ${idExpansion} (${list.length} produits) : aucune série locale`,
    );
  }
}

// Garde-fous (robot de nuit) : pas de prix plus anciens ni de chute brutale.
const outIndex = process.argv.indexOf('--out');
const output =
  outIndex > 0
    ? path.resolve(process.argv[outIndex + 1])
    : path.resolve('cardmarket.json');
let previous;
try {
  previous = JSON.parse(readFileSync(output));
} catch {
  previous = undefined;
}
const linkedCount = Object.keys(links).length;
const previousCount = previous ? Object.keys(previous.products ?? {}).length : 0;
const pricedCount = Object.values(links).filter((link) => link.trend || link.low).length;
const problems = [
  previous && Date.parse(createdAt) < Date.parse(previous.updatedAt)
    ? `prix du ${createdAt} plus anciens que ceux publiés (${previous.updatedAt})`
    : '',
  linkedCount < previousCount * 0.9
    ? `${linkedCount} impressions reliées au lieu de ${previousCount} (chute de plus de 10 %)`
    : '',
  pricedCount === 0 ? 'aucun prix dans le guide Cardmarket' : '',
].filter(Boolean);
if (problems.length > 0) {
  console.error(report.join('\n'));
  console.error(`✗ Rien n'est écrit :\n  ${problems.join('\n  ')}`);
  process.exit(1);
}

writeFileSync(output, `${JSON.stringify({ updatedAt: createdAt, products: links }, null, 2)}\n`);

console.log(report.join('\n'));
console.log(
  `✓ ${path.relative(process.cwd(), output)} : ${Object.keys(links).length} impressions reliées (prix du ${createdAt.slice(0, 10)})`,
);
