// @ts-check
'use strict';

/**
 * Docusaurus plugin that injects the Plausible Analytics script tag.
 *
 * @param {import('@docusaurus/types').LoadContext} _context
 * @param {{ domain?: string }} options
 */
module.exports = function plausiblePlugin(_context, options) {
  return {
    name: 'docusaurus-plugin-plausible',

    injectHtmlTags() {
      return {
        headTags: [
          {
            tagName: 'script',
            attributes: {
              defer: true,
              'data-domain': options.domain || 'docs.bosphor.xyz',
              src: 'https://plausible.io/js/script.js',
            },
          },
        ],
      };
    },
  };
};
