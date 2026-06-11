import {themes as prismThemes} from 'prism-react-renderer';
import type {Config} from '@docusaurus/types';
import type * as Preset from '@docusaurus/preset-classic';

const config: Config = {
  title: 'Bosphor',
  tagline: 'Cross-chain storage intent routing for Walrus',
  favicon: 'img/favicon.png',

  future: {
    v4: true,
  },

  markdown: {
    mermaid: true,
  },

  headTags: [
    {
      tagName: 'meta',
      attributes: {
        name: 'algolia-site-verification',
        content: 'F94D345DC45E170F',
      },
    },
  ],

  url: 'https://docs.bosphor.xyz',
  baseUrl: '/',

  organizationName: 'riva-labs',
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
          routeBasePath: '/',
          remarkPlugins: [require('./plugins/remark-glossary')],
          editUrl:
            'https://github.com/riva-labs/bosphor/tree/main/website/',
        },
        blog: false,
        theme: {
          customCss: './src/css/custom.css',
        },
      } satisfies Preset.Options,
    ],
  ],

  plugins: [
    [
      'docusaurus-plugin-llms',
      {
        generateLLMsTxt: true,
        generateLLMsFullTxt: true,
        docsDir: 'docs',
      },
    ],
    ['./plugins/plausible', { domain: 'docs.bosphor.xyz' }],
    './plugins/descriptions',
  ],

  scripts: [
    {
      src: 'https://cdn.jsdelivr.net/npm/@algolia/experiences/dist/experiences.js?appId=VXT50FAJ6C&apiKey=d27833d51c3d77ebfacdb3a14410a04f&experienceId=59cc6ba2-f485-40c7-ad25-71ad5ef4b280&env=prod',
      defer: true,
    },
  ],

  themes: [
    '@docusaurus/theme-mermaid',
  ],

  themeConfig: {
    colorMode: {
      defaultMode: 'dark',
      disableSwitch: true,
      respectPrefersColorScheme: false,
    },
    navbar: {
      title: 'Bosphor',
      logo: {
        alt: 'Bosphor',
        src: 'img/logo.png',
        width: 32,
        height: 32,
      },
      items: [
        {
          type: 'docSidebar',
          sidebarId: 'tutorialSidebar',
          position: 'left',
          label: 'Docs',
        },
        {
          to: '/quickstart',
          label: 'Quickstart',
          position: 'left',
        },
        {
          type: 'html',
          position: 'right',
          value: '<div id="autocomplete"></div>',
        },
        {
          href: 'https://github.com/riva-labs/bosphor',
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
              to: '/',
            },
            {
              label: 'Architecture',
              to: '/architecture',
            },
            {
              label: 'Deployment',
              to: '/deployment',
            },
          ],
        },
        {
          title: 'Resources',
          items: [
            {
              label: 'GitHub',
              href: 'https://github.com/riva-labs/bosphor',
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
      copyright: `Copyright ${new Date().getFullYear()} Bosphor.`,
    },
    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.dracula,
      additionalLanguages: ['solidity', 'toml'],
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
