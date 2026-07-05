import type {SidebarsConfig} from '@docusaurus/plugin-content-docs';

const sidebars: SidebarsConfig = {
  tutorialSidebar: [
    {
      type: 'category',
      label: 'Getting Started',
      collapsed: false,
      items: [
        'intro',
        'quickstart',
        'glossary',
      ],
    },
    {
      type: 'category',
      label: 'Concepts',
      collapsed: false,
      items: [
        'architecture',
        'lz-verification-flow',
        'security-model',
      ],
    },
    {
      type: 'category',
      label: 'Integrate',
      collapsed: false,
      items: [
        'contract-interface',
        'integration-checklist',
        'dapp-tutorial',
        'public-api',
      ],
    },
    {
      type: 'category',
      label: 'Operate',
      collapsed: false,
      items: [
        'deployment',
        'relayer',
        'canary',
        'testing',
        'troubleshooting',
      ],
    },
    {
      type: 'category',
      label: 'Reference',
      collapsed: false,
      items: [
        'sui-executor',
        'known-limitations',
        'changelog',
      ],
    },
  ],
};

export default sidebars;
