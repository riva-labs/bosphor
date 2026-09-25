import type * as PageTree from 'fumadocs-core/page-tree';
import { getLLMText, source } from './source';
import { links, siteDescription, siteUrl } from './shared';

/**
 * The markdown twin of a docs page: `/docs/quickstart` -> `/docs/quickstart.md`.
 * `scripts/markdown-aliases.mjs` writes these files into the static export after
 * `next build`, from the `/llms.mdx/docs/.../content.md` route output.
 */
export function markdownPathOf(url: string): string {
  return `${url.replace(/\/$/, '')}.md`;
}

const text = (node: unknown): string => (typeof node === 'string' ? node : '');

type Entry = { title: string; url: string; description?: string };
type Page = (typeof source)['$inferPage'];

/** Every page a navigation subtree links to, in sidebar order. */
function collect(nodes: PageTree.Node[], out: Page[]) {
  for (const node of nodes) {
    if (node.type === 'separator') continue;
    if (node.type === 'folder') {
      if (node.index) collect([node.index], out);
      collect(node.children, out);
      continue;
    }
    if (node.external) continue;
    const page = source.getPages().find((p) => p.url === node.url);
    if (page && !out.includes(page)) out.push(page);
  }
}

/** Top-level content folder a page file lives in, e.g. "guides" or "(get-started)". */
const dirOf = (page: Page) => page.path.split('/')[0];

/** Root sections of the portal, in navigation order, with the pages each one owns. */
export function getSections(): { title: string; description: string; pages: Entry[] }[] {
  const tree = source.getPageTree();
  return tree.children
    .filter((n): n is PageTree.Folder => n.type === 'folder')
    .map((folder) => {
      const linked: Page[] = [];
      collect(folder.index ? [folder.index, ...folder.children] : folder.children, linked);
      // A section's sidebar can link into another section (Get started links the
      // Glossary). List each page once, under the folder that holds its file.
      const counts = new Map<string, number>();
      for (const p of linked) counts.set(dirOf(p), (counts.get(dirOf(p)) ?? 0) + 1);
      const home = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
      const pages = linked
        .filter((p) => dirOf(p) === home)
        .map((p) => ({ title: p.data.title, url: p.url, description: p.data.description }));
      return { title: text(folder.name), description: text(folder.description), pages };
    });
}

/**
 * llms.txt, following https://llmstxt.org: an H1 title, a blockquote summary,
 * free-form notes, then one H2 section per portal section with a markdown link
 * list, and an "Optional" section for secondary resources.
 */
export function buildLlmsTxt(): string {
  const lines: string[] = [
    '# Bosphor',
    '',
    `> ${siteDescription}`,
    '',
    'Bosphor is a cross-chain storage intent router. An app on an EVM chain or Solana commits to a Walrus blob id on its own chain, LayerZero carries the commitment to Sui, a relayer stores the bytes on Walrus, and a proof of storage returns to the origin chain, where it releases the escrowed payment. The TypeScript SDK is `@bosphor/sdk` (entry points `@bosphor/sdk/evm` and `@bosphor/sdk/solana`). The hosted testnet uses Ethereum Sepolia and Solana devnet.',
    '',
    `Every page below is linked as plain markdown. Append \`.md\` to any docs URL to get its markdown, or read everything at once in ${siteUrl}/llms-full.txt.`,
  ];

  for (const section of getSections()) {
    if (section.pages.length === 0) continue;
    lines.push('', `## ${section.title}`, '');
    if (section.description) lines.push(`${section.description}.`, '');
    for (const p of section.pages) {
      const href = `${siteUrl}${markdownPathOf(p.url)}`;
      lines.push(`- [${p.title}](${href})${p.description ? `: ${p.description}` : ''}`);
    }
  }

  lines.push(
    '',
    '## Optional',
    '',
    `- [Full documentation](${siteUrl}/llms-full.txt): every page above in one markdown file`,
    `- [Relayer OpenAPI spec](https://api.bosphor.xyz/testnet/openapi.json): OpenAPI 3.1 description of the public relayer HTTP API (testnet)`,
    `- [@bosphor/sdk on npm](${links.npm}): the published SDK package`,
    `- [Source code](${links.github}): the Bosphor monorepo (contracts, relayer, SDK, these docs)`,
    `- [EVM starter](https://github.com/riva-labs/bosphor-evm-starter): runnable Sepolia starter repo`,
    `- [Solana starter](https://github.com/riva-labs/bosphor-solana-starter): runnable Solana devnet starter repo`,
    `- [System status](${links.status}): live health of the hosted testnet`,
    '',
  );
  return lines.join('\n');
}

/** llms-full.txt: a short header, then every page's processed markdown, in navigation order. */
export async function buildLlmsFullTxt(): Promise<string> {
  const ordered = getSections().flatMap((s) => s.pages.map((p) => p.url));
  const pages = source.getPages();
  // Pages in navigation order first, then any page the navigation does not list.
  const byUrl = new Map(pages.map((p) => [p.url, p]));
  const rest = pages.filter((p) => !ordered.includes(p.url));
  const all = [...ordered.map((u) => byUrl.get(u)!).filter(Boolean), ...rest];
  const bodies = await Promise.all(all.map(getLLMText));
  return [
    `# Bosphor developer portal: full documentation`,
    '',
    `> ${siteDescription}`,
    '',
    `Source: ${siteUrl}. Index: ${siteUrl}/llms.txt. ${all.length} pages follow, each starting with its title and URL.`,
    '',
    ...bodies.map((b) => `---\n\n${b}`),
  ].join('\n');
}
