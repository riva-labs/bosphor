// Generates the @bosphor/sdk reference (content/docs/reference/{core,evm,solana})
// from the SDK source with TypeDoc + typedoc-plugin-markdown, so the reference
// can never drift from the code. Runs before `next build` and `next dev`; the
// output is git-ignored.
//
// Layout: one folder per entry point, one page per export group:
//   reference/core/     @bosphor/sdk         (also serves @bosphor/sdk/commitment)
//   reference/evm/      @bosphor/sdk/evm
//   reference/solana/   @bosphor/sdk/solana
// Each folder has an index page (the entry point overview and what it re-exports)
// plus Clients, Functions, Commitment codec, Errors, Constants and Types pages,
// whichever the entry point has. A symbol exported from several entry points is
// documented once, where it is defined, and linked from the others.
//
// Run: node scripts/gen-sdk-reference.mjs
import fs from 'node:fs';
import path from 'node:path';
import {
  Application,
  Converter,
  DeclarationReflection,
  ReflectionGroup,
  ReflectionKind,
  TSConfigReader,
} from 'typedoc';
import { MarkdownPageEvent, ModuleRouter } from 'typedoc-plugin-markdown';

const siteRoot = path.resolve(import.meta.dirname, '..');
const repoRoot = path.resolve(siteRoot, '..');
const sdkRoot = path.join(repoRoot, 'sdk');
const refDir = path.join(siteRoot, 'content', 'docs', 'reference');
const tmpDir = path.join(siteRoot, '.sdk-reference');

/** Entry points, in the order their areas appear in the sidebar. */
const AREAS = [
  {
    entry: 'src/index.ts',
    slug: 'core',
    title: 'Core',
    importPath: '@bosphor/sdk',
    description:
      'Chain-agnostic exports of @bosphor/sdk: the commitment codec, shared types, errors, quoting, and network presets.',
  },
  {
    entry: 'src/evm/index.ts',
    slug: 'evm',
    title: 'EVM',
    importPath: '@bosphor/sdk/evm',
    description: 'The EVM origin client of @bosphor/sdk, its factories, the adapter ABI, and the EVM types.',
  },
  {
    entry: 'src/solana/index.ts',
    slug: 'solana',
    title: 'Solana',
    importPath: '@bosphor/sdk/solana',
    description:
      'The Solana origin client of @bosphor/sdk, its factories, LayerZero send accounts, and the Solana types.',
  },
];

/** Export groups, in page order. Each becomes one page per entry point. */
const GROUPS = [
  { name: 'Clients', slug: 'clients', description: 'Client classes and the factories that build them.' },
  { name: 'Functions', slug: 'functions', description: 'Helper functions and factories.' },
  {
    name: 'Commitment codec',
    slug: 'commitment-codec',
    description: 'The 49-byte commitment wire format, its codec, and the intent-id derivation.',
  },
  { name: 'Errors', slug: 'errors', description: 'Error classes. Every SDK error extends BosphorError.' },
  { name: 'Constants', slug: 'constants', description: 'Constants, network presets, and ABIs.' },
  { name: 'Types', slug: 'types', description: 'Interfaces and type aliases.' },
];

const isFunctionValued = (r) =>
  r.type?.type === 'reflection' && (r.type.declaration.signatures?.length ?? 0) > 0;

/** Which export group a top-level declaration belongs to. */
function groupOf(r) {
  const file = r.sources?.[0]?.fullFileName ?? '';
  if (file.endsWith('/commitment-codec.ts')) return 'Commitment codec';
  if (r.kindOf(ReflectionKind.Class)) {
    if (/Error$/.test(r.name)) return 'Errors';
    if (/Client$/.test(r.name)) return 'Clients';
    return 'Types';
  }
  if (r.kindOf(ReflectionKind.Function)) return /^create\w*Client/.test(r.name) ? 'Clients' : 'Functions';
  if (r.kindOf(ReflectionKind.Variable)) {
    // A const holding a function (for example `defaultComputeBlob`) is a helper.
    return isFunctionValued(r) || r.type?.type === 'reference' && /ComputeBlob$/.test(r.type.name)
      ? 'Functions'
      : 'Constants';
  }
  if (r.kindOf(ReflectionKind.Enum)) return 'Constants';
  return 'Types';
}

/** True when a declaration comes from outside the SDK (Error, Node typings). */
const isExternal = (r) =>
  (r.sources?.length ?? 0) > 0 && r.sources.every((s) => !s.fullFileName.startsWith(sdkRoot + '/src/'));

/**
 * Routes each module to `<area>/index` and each export-group namespace to
 * `<area>/<group>`, so every page lands at a stable URL.
 */
class ReferenceRouter extends ModuleRouter {
  getIdealBaseName(reflection) {
    if (reflection.kindOf(ReflectionKind.Module)) return `${areaOf(reflection).slug}/index`;
    if (reflection.kindOf(ReflectionKind.Namespace)) {
      const group = GROUPS.find((g) => g.name === reflection.name);
      if (group && reflection.parent?.kindOf(ReflectionKind.Module)) {
        return `${areaOf(reflection.parent).slug}/${group.slug}`;
      }
    }
    return super.getIdealBaseName(reflection);
  }
}

const areaByModuleName = new Map();
function areaOf(mod) {
  const area = areaByModuleName.get(mod.name);
  if (!area) throw new Error(`gen-sdk-reference: no area for module "${mod.name}"`);
  return area;
}

/**
 * Names each entry-point module after its area and drops members inherited from
 * outside the SDK, such as Error.captureStackTrace. Runs when resolution begins.
 */
function prepare(context) {
  const project = context.project;
  for (const mod of project.getChildrenByKind(ReflectionKind.Module)) {
    const rel = path.relative(sdkRoot, mod.sources?.[0]?.fullFileName ?? '');
    const area = AREAS.find((a) => a.entry === rel);
    if (!area) throw new Error(`gen-sdk-reference: unexpected module ${mod.name} (${rel})`);
    mod.name = area.title;
    areaByModuleName.set(mod.name, area);
    for (const child of mod.children ?? []) {
      for (const member of [...(child.children ?? [])]) {
        if (isExternal(member)) project.removeReflection(member);
      }
    }
  }
}

/** True when a declaration (or, for a function, its first signature) has a TSDoc summary. */
const hasSummary = (r) =>
  [r.comment, ...(r.signatures ?? []).map((sig) => sig.comment)].some((c) => c?.summary.some((p) => p.text.trim()));

/** Kind sections inside a group page, in order. */
const KIND_ORDER = [
  ReflectionKind.Class,
  ReflectionKind.Function,
  ReflectionKind.Variable,
  ReflectionKind.Enum,
  ReflectionKind.Interface,
  ReflectionKind.TypeAlias,
];

function groupByKind(owner, children) {
  const groups = [];
  const rest = [...children];
  for (const kind of [...KIND_ORDER, ReflectionKind.Namespace, ReflectionKind.Reference]) {
    const members = rest.filter((c) => c.kind === kind);
    if (!members.length) continue;
    const g = new ReflectionGroup(ReflectionKind.pluralString(kind), owner);
    g.children = members;
    groups.push(g);
    for (const m of members) rest.splice(rest.indexOf(m), 1);
  }
  if (rest.length) {
    throw new Error(`gen-sdk-reference: unhandled kinds: ${rest.map((r) => `${r.name} (${ReflectionKind[r.kind]})`)}`);
  }
  return groups;
}

/**
 * Moves every top-level export of each entry point into one namespace per export
 * group, so the router gives each group its own page. Runs after TypeDoc has
 * resolved {@link} targets (which search the original module scope) and rebuilds
 * the section groups the move invalidated.
 */
function regroup(context) {
  const project = context.project;
  const undocumented = [];
  for (const mod of project.getChildrenByKind(ReflectionKind.Module)) {
    const buckets = new Map();
    for (const child of [...(mod.children ?? [])]) {
      if (child.kindOf(ReflectionKind.Reference)) continue; // listed on the index page
      if (!hasSummary(child)) undocumented.push(`${mod.name}: ${child.name}`);
      const name = groupOf(child);
      if (!buckets.has(name)) buckets.set(name, []);
      buckets.get(name).push(child);
    }

    const namespaces = [];
    for (const group of GROUPS) {
      const members = buckets.get(group.name);
      if (!members?.length) continue;
      const ns = new DeclarationReflection(group.name, ReflectionKind.Namespace, mod);
      project.registerReflection(ns, undefined, undefined);
      for (const member of members) {
        mod.removeChild(member);
        member.parent = ns;
        ns.addChild(member);
      }
      ns.groups = groupByKind(ns, ns.children);
      namespaces.push(ns);
    }
    const references = [...(mod.children ?? [])];
    for (const ns of namespaces) mod.addChild(ns);
    mod.groups = groupByKind(mod, [...namespaces, ...references]);
    mod.categories = undefined;
  }
  // Every public export needs a TSDoc summary, or its reference entry is empty.
  if (undocumented.length) {
    throw new Error(`gen-sdk-reference: public exports without a TSDoc summary:\n  ${undocumented.join('\n  ')}`);
  }
}

const yamlString = (s) => JSON.stringify(s);

/** Site URL of a generated file path such as `evm/clients.mdx#x`. */
function siteUrl(file) {
  const [p, hash] = file.split('#');
  const slug = p.replace(/\.mdx$/, '').replace(/(^|\/)index$/, '');
  return `/docs/reference/${slug}`.replace(/\/$/, '') + (hash ? `#${hash}` : '');
}

/** Rewrites relative `.mdx` links to absolute site URLs (for llms.txt and search too). */
function absoluteLinks(body, pageUrl) {
  return body.replace(/\]\(((?:\.\.\/|\.\/)?[\w./-]+\.mdx)(#[^)\s]*)?\)/g, (_, file, hash = '') =>
    `](${siteUrl(path.posix.join(path.posix.dirname(pageUrl), file) + hash)})`,
  );
}

/**
 * Structural sub-headings the plugin emits under every symbol (Parameters,
 * Returns, ...). Rendered as bold labels instead, so the table of contents lists
 * only symbols and their members.
 */
const SECTION_LABELS = new Set([
  'Accessors', 'Call Signature', 'Constructors', 'Default Value', 'Deprecated', 'Example', 'Examples',
  'Extended by', 'Extends', 'Implementation of', 'Implements', 'Index Signature', 'Inherited from',
  'Methods', 'Overrides', 'Parameters', 'Properties', 'Remarks', 'Returns', 'See', 'Throws',
  'Type Declaration', 'Type Parameters',
]);

function sectionLabels(body) {
  let inFence = false;
  return body
    .split('\n')
    .map((line) => {
      if (line.startsWith('```')) inFence = !inFence;
      const m = !inFence && /^#{4,6} (.+)$/.exec(line);
      return m && SECTION_LABELS.has(m[1]) ? `**${m[1]}**` : line;
    })
    .join('\n');
}

const code = (name) => `\`${name}\``;

/**
 * The area index page: the entry point overview from its TSDoc, one row per group
 * page with the exports it documents, and the exports documented elsewhere.
 */
function moduleIndex(area, mod, rendered, router) {
  // Keep the entry point's own TSDoc (rendered above the plugin's index tables).
  const intro = rendered.split(/^## /m)[0].trim();
  const out = [`Import from ${code(area.importPath)}. This reference is generated from the SDK source.`, ''];
  if (intro) out.push(intro, '');
  const url = (r) => siteUrl(router.getFullUrl(r));
  const byName = (x, y) => x.name.localeCompare(y.name, 'en', { sensitivity: 'base' });

  const namespaces = (mod.children ?? []).filter((c) => c.kindOf(ReflectionKind.Namespace));
  out.push('## Pages', '', '| Page | Exports |', '| :-- | :-- |');
  for (const ns of namespaces) {
    const names = [...(ns.children ?? [])].sort(byName).map((c) => `[${code(c.name)}](${url(c)})`);
    out.push(`| [${ns.name}](${url(ns)}) | ${names.join(', ')} |`);
  }

  const refs = (mod.children ?? []).filter((c) => c.kindOf(ReflectionKind.Reference));
  if (refs.length) {
    out.push(
      '',
      '## Re-exports',
      '',
      `${code(area.importPath)} also re-exports these, so one import is enough. Each is documented once, where it is defined.`,
      '',
      '| Export | Documented in |',
      '| :-- | :-- |',
    );
    for (const ref of refs) {
      const target = ref.getTargetReflectionDeep();
      const ns = target.parent;
      const where = `${areaOf(ns.parent).title} / ${ns.name}`;
      out.push(`| [${code(ref.name)}](${url(target)}) | ${where} |`);
    }
  }
  return out.join('\n');
}

async function main() {
  if (!fs.existsSync(path.join(sdkRoot, 'node_modules'))) {
    throw new Error('gen-sdk-reference: run `npm ci` in sdk/ first (TypeDoc type-checks sdk/src)');
  }

  const app = await Application.bootstrapWithPlugins(
    {
      plugin: ['typedoc-plugin-markdown'],
      tsconfig: path.join(sdkRoot, 'tsconfig.json'),
      entryPoints: AREAS.map((a) => path.join(sdkRoot, a.entry)),
      out: tmpDir,
      readme: 'none',
      // Source paths (shown and linked) are relative to the repo root.
      displayBasePath: repoRoot,
      excludeInternal: true,
      excludePrivate: true,
      excludeProtected: true,
      excludeExternals: true,
      disableSources: false,
      sourceLinkTemplate: 'https://github.com/riva-labs/bosphor/blob/main/{path}#L{line}',
      gitRevision: 'main',
      // Links use displayBasePath, so no git lookup is needed (and worktrees work).
      disableGit: true,
      // Markdown plugin: MDX output, one page per module and namespace.
      router: 'bosphor-reference',
      fileExtension: '.mdx',
      entryFileName: 'index',
      hidePageHeader: true,
      hideBreadcrumbs: true,
      hidePageTitle: true,
      hideGroupHeadings: false,
      useCodeBlocks: true,
      expandObjects: false,
      expandParameters: false,
      parametersFormat: 'table',
      interfacePropertiesFormat: 'table',
      classPropertiesFormat: 'table',
      typeAliasPropertiesFormat: 'table',
      enumMembersFormat: 'table',
      propertyMembersFormat: 'table',
      typeDeclarationFormat: 'table',
      indexFormat: 'table',
      tableColumnSettings: { hideSources: true, leftAlignHeaders: true },
      sanitizeComments: true,
      validation: { notExported: false, invalidLink: true, rewrittenLink: true },
      treatValidationWarningsAsErrors: true,
      logLevel: 'Warn',
    },
    [new TSConfigReader()],
  );

  app.renderer.defineRouter('bosphor-reference', ReferenceRouter);
  app.converter.on(Converter.EVENT_RESOLVE_BEGIN, prepare, 100);
  // After the link resolver (-300), which searches the original module scope.
  app.converter.on(Converter.EVENT_RESOLVE_END, regroup, -400);

  // Page post-processing: frontmatter, the area index layout, absolute links.
  app.renderer.on(MarkdownPageEvent.END, (page) => {
    const model = page.model;
    // The project-level index is not used: each area has its own index page.
    if (model.kindOf(ReflectionKind.Project)) return;
    const router = app.renderer.router;
    let title;
    let description;
    let body = page.contents;
    if (model.kindOf(ReflectionKind.Module)) {
      const area = areaOf(model);
      title = area.title;
      description = area.description;
      body = moduleIndex(area, model, body, router);
    } else {
      const group = GROUPS.find((g) => g.name === model.name);
      title = model.name;
      description = `${group?.description ?? ''} Exported from ${areaOf(model.parent).importPath}.`.trim();
    }
    body = absoluteLinks(sectionLabels(body), page.url);
    page.contents = `---\ntitle: ${yamlString(title)}\ndescription: ${yamlString(description)}\n---\n\n${body.trim()}\n`;
  });

  const project = await app.convert();
  if (!project) throw new Error('gen-sdk-reference: TypeDoc conversion failed');
  app.validate(project);
  if (app.logger.hasErrors() || app.logger.hasWarnings()) {
    throw new Error('gen-sdk-reference: TypeDoc reported problems (see above)');
  }

  fs.rmSync(tmpDir, { recursive: true, force: true });
  await app.generateOutputs(project);
  if (app.logger.hasErrors()) throw new Error('gen-sdk-reference: rendering failed');

  let pages = 0;
  for (const area of AREAS) {
    const from = path.join(tmpDir, area.slug);
    const to = path.join(refDir, area.slug);
    fs.rmSync(to, { recursive: true, force: true });
    fs.cpSync(from, to, { recursive: true });
    const present = GROUPS.filter((g) => fs.existsSync(path.join(to, `${g.slug}.mdx`))).map((g) => g.slug);
    pages += present.length + 1;
    fs.writeFileSync(
      path.join(to, 'meta.json'),
      JSON.stringify({ title: area.title, pages: ['index', ...present] }, null, 2) + '\n',
    );
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.log(`gen-sdk-reference: ${pages} pages in ${path.relative(siteRoot, refDir)}/{${AREAS.map((a) => a.slug)}}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
