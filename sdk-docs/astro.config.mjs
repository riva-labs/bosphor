// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import starlightTypeDoc, { typeDocSidebarGroup } from 'starlight-typedoc';

// https://astro.build/config
export default defineConfig({
  site: 'https://sdk.bosphor.xyz',
  integrations: [
    starlight({
      title: 'Bosphor SDK',
      description:
        'TypeScript SDK for Bosphor: submit cross-chain storage intents from EVM or Solana and route them to Walrus.',
      logo: { src: './src/assets/bosphor-mark.png', replacesTitle: false },
      favicon: '/bosphor-mark.png',
      customCss: ['./src/styles/brand.css'],
      // Light-only, like the dApp: pin the code blocks to a light theme so they
      // match the palette even when the visitor's system prefers dark.
      expressiveCode: { themes: ['github-light'] },
      // Remove the dark/light toggle (the site is light only).
      components: { ThemeSelect: './src/components/EmptyThemeSelect.astro' },
      social: [
        { icon: 'github', label: 'GitHub', href: 'https://github.com/riva-labs/bosphor' },
      ],
      // The API reference is generated from the SDK source with TypeDoc at build
      // time; the plugin injects the pages and returns a sidebar group for them.
      plugins: [
        starlightTypeDoc({
          entryPoints: [
            '../sdk/src/index.ts',
            '../sdk/src/evm/index.ts',
            '../sdk/src/solana/index.ts',
            '../sdk/src/commitment-codec.ts',
          ],
          tsconfig: '../sdk/tsconfig.json',
          output: 'reference',
          sidebar: { label: 'API reference', collapsed: true },
          typeDoc: {
            excludeInternal: true,
            excludePrivate: true,
            skipErrorChecking: true,
          },
        }),
      ],
      sidebar: [
        {
          label: 'Start here',
          items: [
            { label: 'Overview', link: '/' },
            { label: 'Quickstart', link: '/getting-started/quickstart/' },
          ],
        },
        {
          label: 'Guides',
          items: [
            { label: 'Store from EVM', link: '/guides/evm/' },
            { label: 'Store from Solana', link: '/guides/solana/' },
            { label: 'Handle errors', link: '/guides/errors/' },
            { label: 'Resume after a crash', link: '/guides/resume/' },
          ],
        },
        {
          label: 'Concepts',
          items: [{ label: 'How routing works', link: '/concepts/how-it-works/' }],
        },
        // Auto-generated TypeDoc API reference.
        typeDocSidebarGroup,
      ],
    }),
  ],
});
