import { source } from '@/lib/source';
import { DocsLayout } from 'fumadocs-ui/layouts/notebook';
import { baseOptions } from '@/lib/layout.shared';
import { SiteFooter } from '@/components/site-footer';

// Notebook layout: the root sections (Get started, Guides, SDK reference, ...)
// render as tabs in the top navbar, and the sidebar lists only the active
// section's pages. The page component must come from the matching
// `fumadocs-ui/layouts/notebook/page` entry, or the content area renders blank.
export default function Layout({ children }: LayoutProps<'/docs'>) {
  const base = baseOptions();
  return (
    <DocsLayout
      tree={source.getPageTree()}
      {...base}
      nav={{ ...base.nav, mode: 'top' }}
      tabMode="navbar"
    >
      {children}
      {/* Full width, and pinned to the last grid row so it never lands above the page on mobile. */}
      <SiteFooter className="mt-8 [grid-column:1/-1] [grid-row:99]" />
    </DocsLayout>
  );
}
