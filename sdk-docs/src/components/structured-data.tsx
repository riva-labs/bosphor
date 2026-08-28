// JSON-LD structured data. Search engines use it for rich results; AI answer
// engines use it to ground and attribute answers (GEO). Rendered as a plain
// <script type="application/ld+json"> so it works in the static export.

const BASE = 'https://sdk.bosphor.xyz';

function JsonLd({ data }: { data: Record<string, unknown> }) {
  return (
    <script
      type="application/ld+json"
      // eslint-disable-next-line react/no-danger
      dangerouslySetInnerHTML={{ __html: JSON.stringify(data) }}
    />
  );
}

/** Site-wide identity: the docs site and the org behind it. */
export function SiteStructuredData() {
  return (
    <>
      <JsonLd
        data={{
          '@context': 'https://schema.org',
          '@type': 'WebSite',
          '@id': `${BASE}/#website`,
          name: 'Bosphor SDK',
          url: BASE,
          description:
            'TypeScript SDK for Bosphor: store a file on Walrus from an EVM or Solana wallet, over LayerZero, with a verifiable proof back on the origin chain.',
          inLanguage: 'en',
          publisher: { '@id': `${BASE}/#org` },
        }}
      />
      <JsonLd
        data={{
          '@context': 'https://schema.org',
          '@type': 'Organization',
          '@id': `${BASE}/#org`,
          name: 'Bosphor',
          url: 'https://bosphor.xyz',
          sameAs: ['https://github.com/riva-labs/bosphor'],
        }}
      />
      <JsonLd
        data={{
          '@context': 'https://schema.org',
          '@type': 'SoftwareSourceCode',
          name: '@bosphor/sdk',
          description:
            'Cross-chain storage-intent SDK: submit from EVM or Solana, route to Walrus, verify a proof back on the origin chain.',
          programmingLanguage: 'TypeScript',
          runtimePlatform: 'Node.js',
          codeRepository: 'https://github.com/riva-labs/bosphor',
          url: BASE,
        }}
      />
    </>
  );
}

/** Per-page article + breadcrumb trail. */
export function PageStructuredData({
  title,
  description,
  url,
  breadcrumb,
}: {
  title: string;
  description?: string;
  url: string;
  breadcrumb: { name: string; url: string }[];
}) {
  return (
    <>
      <JsonLd
        data={{
          '@context': 'https://schema.org',
          '@type': 'TechArticle',
          headline: title,
          description,
          url: `${BASE}${url}`,
          inLanguage: 'en',
          isPartOf: { '@id': `${BASE}/#website` },
          author: { '@id': `${BASE}/#org` },
          publisher: { '@id': `${BASE}/#org` },
        }}
      />
      <JsonLd
        data={{
          '@context': 'https://schema.org',
          '@type': 'BreadcrumbList',
          itemListElement: breadcrumb.map((crumb, i) => ({
            '@type': 'ListItem',
            position: i + 1,
            name: crumb.name,
            item: `${BASE}${crumb.url}`,
          })),
        }}
      />
    </>
  );
}

/** FAQPage schema for the FAQ. Eligible for FAQ rich results and AI grounding. */
export function FaqStructuredData({ items }: { items: { q: string; a: string }[] }) {
  return (
    <JsonLd
      data={{
        '@context': 'https://schema.org',
        '@type': 'FAQPage',
        mainEntity: items.map((item) => ({
          '@type': 'Question',
          name: item.q,
          acceptedAnswer: { '@type': 'Answer', text: item.a },
        })),
      }}
    />
  );
}
