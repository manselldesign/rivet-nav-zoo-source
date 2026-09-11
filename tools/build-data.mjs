/**
 * build-data.mjs — generates the embedded site-data block inside ../index.html
 *
 * Reads the two structured extractions produced by the analysis passes:
 *   <analysis>/extracted.json  — per-page content for all 216 pages
 *   <analysis>/tree.json       — parent/child map + depth per page (used only to cross-check)
 *
 * ...and rewrites the region of index.html delimited by:
 *   // @generated:site-data:start   …   // @generated:site-data:end
 *
 * Nothing here invents copy. Every string written into index.html is copied
 * verbatim out of extracted.json, which was itself scraped from the 216 raw
 * HTML pages in <analysis>/pages/.
 *
 * Usage:
 *   node tools/build-data.mjs [pathToAnalysisDir]
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT = resolve(HERE, '..');
const ANALYSIS = resolve(process.argv[2] ?? '/Users/mansell/rivet-prototype-analysis');
const TARGET = join(PROJECT, 'index.html');

const PREFIX = '/rivet-2026-06-17/prototype-05';
const HOME_SLUG = 'index'; // extracted.json calls the home page "index"

const extracted = JSON.parse(readFileSync(join(ANALYSIS, 'extracted.json'), 'utf8'));
const tree = JSON.parse(readFileSync(join(ANALYSIS, 'tree.json'), 'utf8'));

const problems = [];
const note = (msg) => problems.push(msg);

/** Source paths are absolute site paths; the prototype keys everything by slug. */
const pathToSlug = (p) => {
  if (p == null) return null;
  const trimmed = p.replace(/\/$/, '');
  if (trimmed === PREFIX) return HOME_SLUG;
  if (!trimmed.startsWith(PREFIX + '/')) {
    note(`external or unexpected path kept verbatim: ${p}`);
    return null;
  }
  return trimmed.slice(PREFIX.length + 1);
};

// ---------------------------------------------------------------------------
// 1. Ordered children.
//
// The source site renders a *contextual* nav: on any page that has children,
// the nav emits a branch link carrying aria-current="page" plus a <ul> of that
// page's children, in authored order. On a leaf page the branch link instead
// carries data-current="true" and points at the parent, and the <ul> holds the
// leaf's siblings. So every page-with-children publishes its own ordered child
// list on its own page. tree.json also has a children map, but its arrays are
// unordered — we use it purely as a set-equality cross-check.
// ---------------------------------------------------------------------------
const childrenBySlug = new Map();

for (const [path, page] of Object.entries(extracted)) {
  const slug = pathToSlug(path);
  const items = page.nav_items ?? [];
  const cur = page.nav_current;

  const ownsList =
    slug === HOME_SLUG || (cur && cur.attr.includes('aria-current') && pathToSlug(cur.href) === slug);

  if (ownsList) {
    childrenBySlug.set(
      slug,
      items.map((it) => pathToSlug(it.href)),
    );
  }
}

// Cross-check ordered children against tree.json's unordered map. Extra
// entries in the nav list are real: the source cross-links a handful of pages
// from a second parent, and tree.json only records the canonical one.
const crossLinks = [];
for (const [parentPath, kids] of Object.entries(tree.children)) {
  const parent = pathToSlug(parentPath);
  const mine = childrenBySlug.get(parent);
  if (!mine) {
    note(`tree.json lists children for "${parent}" but no page published an ordered list`);
    continue;
  }
  const declared = new Set(kids.map(pathToSlug));
  const extra = mine.filter((c) => !declared.has(c));
  const missing = [...declared].filter((c) => !mine.includes(c));
  for (const c of extra) crossLinks.push(`${parent} -> ${c}`);
  if (missing.length) note(`"${parent}" nav omits tree.json children: ${missing.join(', ')}`);
}

// ---------------------------------------------------------------------------
// 2. Labels, parents, depth.
//
// A page's nav label is the text of the last breadcrumb (identical to the text
// the parent's nav <ul> uses for it). Home has no breadcrumbs; the source's own
// name for it is the sr-only text "Home" in the first crumb of every other page.
//
// The parent comes from the second-to-last breadcrumb, NOT from the nav's own
// "Back" link. Back goes up from the *branch* the nav is showing, so on a leaf
// page (where the branch link is the parent) it points at the grandparent.
// ---------------------------------------------------------------------------
const labelOf = new Map([[HOME_SLUG, 'Home']]);
const parentOf = new Map([[HOME_SLUG, null]]);

for (const [path, page] of Object.entries(extracted)) {
  const slug = pathToSlug(path);
  if (slug === HOME_SLUG) continue;
  const last = page.crumbs[page.crumbs.length - 1];
  if (!last || !last.current) note(`page "${slug}" has no current breadcrumb`);
  labelOf.set(slug, last.label);
  parentOf.set(slug, pathToSlug(page.crumbs[page.crumbs.length - 2].href));
}

const depthOf = (slug) => {
  let d = 0;
  let cur = slug;
  while (parentOf.get(cur)) {
    cur = parentOf.get(cur);
    if (++d > 12) throw new Error(`breadcrumb cycle at ${slug}`);
  }
  return d;
};

// Verify the derived parent chain reproduces the source breadcrumb trail
// exactly — labels and order. If it does, the prototype can rebuild every
// breadcrumb from the tree alone instead of storing 216 trails.
for (const [path, page] of Object.entries(extracted)) {
  const slug = pathToSlug(path);
  if (slug === HOME_SLUG) continue;
  const chain = [];
  for (let c = slug; c; c = parentOf.get(c)) chain.unshift(c);
  const derived = chain.map((s) => labelOf.get(s)).join(' / ');
  const actual = page.crumbs.map((c) => c.label).join(' / ');
  if (derived !== actual) note(`breadcrumb mismatch on "${slug}":\n    derived: ${derived}\n    source:  ${actual}`);

  const declared = tree.depth[path];
  if (declared != null && declared !== depthOf(slug)) {
    note(`depth mismatch on "${slug}": derived ${depthOf(slug)} vs tree.json ${declared}`);
  }
}

// ---------------------------------------------------------------------------
// 3. Emit. Keys are terse because this object ships inside the HTML file.
//    t=title  l=nav label  p=parent  c=children  v=depth  e=eyebrow  h=h1
//    d=teaser/lede  a=hero actions  i=hero image  s=body h2  b=body paragraphs
// ---------------------------------------------------------------------------
const IMG_ORIGIN = 'https://basham.github.io';

const pages = {};
const order = [];

for (const [path, page] of Object.entries(extracted)) {
  const slug = pathToSlug(path);
  order.push(slug);

  const rec = { t: page.title, l: labelOf.get(slug), v: depthOf(slug) };

  const parent = parentOf.get(slug);
  if (parent) rec.p = parent;

  const kids = childrenBySlug.get(slug);
  if (kids && kids.length) rec.c = kids;

  if (page.eyebrow) rec.e = page.eyebrow;
  rec.h = page.h1;
  rec.d = page.teaser;

  if (page.actions?.length) {
    rec.a = page.actions.map((x) => ({ l: x.label, h: pathToSlug(x.href) }));
  }
  if (page.img_src) {
    // The source serves responsive WebP from the live GitHub Pages origin. The
    // prototype is a single file with no assets, so it points at that origin.
    rec.i = { s: IMG_ORIGIN + page.img_src, a: page.img_alt };
  }
  if (page.rt_h2) rec.s = page.rt_h2;
  if (page.rt_p?.length) rec.b = page.rt_p;

  pages[slug] = rec;
}

// Sort by depth then source order so the emitted object reads top-down.
order.sort((a, b) => pages[a].v - pages[b].v || order.indexOf(a) - order.indexOf(b));

// Every link target must exist — the source link graph is closed and the
// prototype has to preserve that.
for (const [slug, rec] of Object.entries(pages)) {
  for (const c of rec.c ?? []) if (!pages[c]) note(`"${slug}" links to missing child "${c}"`);
  if (rec.p && !pages[rec.p]) note(`"${slug}" has missing parent "${rec.p}"`);
  for (const a of rec.a ?? []) if (!pages[a.h]) note(`"${slug}" action links to missing page "${a.h}"`);
}

const ordered = {};
for (const slug of order) ordered[slug] = pages[slug];

const body = [
  '    /* eslint-disable */',
  `    // ${order.length} pages, generated by tools/build-data.mjs — do not hand-edit.`,
  '    const SITE = ' + JSON.stringify({ home: HOME_SLUG, pages: ordered }) + ';',
].join('\n');

const html = readFileSync(TARGET, 'utf8');
const START = '// @generated:site-data:start';
const END = '// @generated:site-data:end';
const i = html.indexOf(START);
const j = html.indexOf(END);
if (i < 0 || j < 0) throw new Error(`markers ${START} / ${END} not found in ${TARGET}`);

const out = html.slice(0, i + START.length) + '\n' + body + '\n    ' + html.slice(j);
writeFileSync(TARGET, out);

// ---------------------------------------------------------------------------
console.log(`pages emitted:      ${order.length}`);
console.log(`pages with children:${childrenBySlug.size}`);
console.log(`max depth:          ${Math.max(...Object.values(pages).map((p) => p.v))}`);
console.log(`data bytes:         ${body.length.toLocaleString()}`);
console.log(`index.html bytes:   ${out.length.toLocaleString()}`);

if (crossLinks.length) {
  // Not an error. These pages appear in two parents' nav lists in the source.
  // Both nav paths are kept so the link graph stays closed; the breadcrumb
  // trail (and therefore the parent chain) uses the canonical parent.
  console.log(`\ncross-links kept (page listed under a second parent):`);
  for (const c of crossLinks) console.log('  - ' + c);
}
if (problems.length) {
  console.log(`\n${problems.length} PROBLEM(S):`);
  for (const p of problems) console.log('  - ' + p);
  process.exitCode = 1;
} else {
  console.log('\nno problems: ordered children, parent chains, breadcrumb labels and depths all agree.');
}
