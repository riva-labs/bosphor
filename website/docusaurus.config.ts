import {themes as prismThemes} from 'prism-react-renderer';
import type {Config} from '@docusaurus/types';
import type * as Preset from '@docusaurus/preset-classic';

const config: Config = {
  title: 'Bosphor',
  tagline: 'Cross-chain storage intent routing for Walrus',
  favicon: 'img/favicon.ico',

  future: {
    v4: true,
  },

  url: 'https://AliErcanOzgokce.github.io',
  baseUrl: '/bosphor/',

  organizationName: 'AliErcanOzgokce',
  projectName: 'bosphor',

  onBrokenLinks: 'throw',

  i18n: {
    defaultLocale: 'en',
    locales: ['en'],
  },

  presets: [
    [
      'classic',
      {
        docs: {
          sidebarPath: './sidebars.ts',
          editUrl:
            'https://github.com/AliErcanOzgokce/bosphor/tree/main/website/',
        },
        blog: false,
        theme: {
          customCss: './src/css/custom.css',
        },
      } satisfies Preset.Options,
    ],
  ],

  themeConfig: {
    colorMode: {
      respectPrefersColorScheme: true,
    },
    navbar: {
      title: 'Bosphor',
      logo: {
        alt: 'Bosphor Logo',
        src: 'img/logo.svg',
      },
      items: [
        {
          type: 'docSidebar',
          sidebarId: 'tutorialSidebar',
          position: 'left',
          label: 'Docs',
        },
        {
          to: '/docs/quickstart',
          label: 'Quickstart',
          position: 'left',
        },
        {
          href: 'https://github.com/AliErcanOzgokce/bosphor',
          label: 'GitHub',
          position: 'right',
        },
      ],
    },
    footer: {
      style: 'dark',
      logo: {
        alt: 'Powered by Walrus',
        src: 'img/walrus.svg',
        href: 'https://www.walrus.xyz/',
        width: 120,
        height: 40,
      },
      links: [
        {
          title: 'Docs',
          items: [
            {
              label: 'Introduction',
              to: '/docs/',
            },
            {
              label: 'Architecture',
              to: '/docs/architecture',
            },
            {
              label: 'Deployment',
              to: '/docs/deployment',
            },
          ],
        },
        {
          title: 'Resources',
          items: [
            {
              label: 'GitHub',
              href: 'https://github.com/AliErcanOzgokce/bosphor',
            },
            {
              label: 'Walrus',
              href: 'https://www.walrus.xyz/',
            },
            {
              label: 'LayerZero',
              href: 'https://layerzero.network/',
            },
            {
              label: 'Sui',
              href: 'https://sui.io/',
            },
          ],
        },
      ],
      copyright: `Copyright ${new Date().getFullYear()} Bosphor. Built with Docusaurus.`,
    },
    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.dracula,
      additionalLanguages: ['solidity', 'toml'],
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
