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
      // Self-host the fonts (bundled by Astro, served same-origin) instead of a
      // render-blocking Google Fonts @import. That import stalls text rendering
      // when fonts.googleapis.com is slow or blocked on the visitor's network.
      customCss: [
        '@fontsource-variable/inter',
        '@fontsource/jetbrains-mono/400.css',
        '@fontsource/jetbrains-mono/500.css',
        '@fontsource/jetbrains-mono/600.css',
        './src/styles/brand.css',
      ],
      // Light-only: pin the code blocks to a light theme, and neutralise
      // expressive-code's dark "terminal" frame so bash and ts blocks look the
      // same, clean light card (no macOS-style dark title bar).
      expressiveCode: {
        themes: ['github-light'],
        styleOverrides: {
          borderRadius: '0.5rem',
          borderColor: '#e5e5e7',
          frames: {
            shadowColor: 'transparent',
            editorTabBarBackground: '#f7f7f8',
            editorActiveTabBackground: '#ffffff',
            editorBackground: '#fbfbfc',
            terminalBackground: '#fbfbfc',
            terminalTitlebarBackground: '#f7f7f8',
            terminalTitlebarBorderBottomColor: '#e5e5e7',
            terminalTitlebarDotsForeground: '#c8c8ce',
            terminalTitlebarForeground: '#787887',
          },
        },
      },
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
