import { HomeLayout } from 'fumadocs-ui/layouts/home';
import { baseOptions } from '@/lib/layout.shared';

export default function Layout({ children }: LayoutProps<'/'>) {
  const base = baseOptions();
  return (
    <HomeLayout
      {...base}
      links={[
        { text: 'Docs', url: '/docs', active: 'nested-url' },
        { text: 'Quickstart', url: '/docs/quickstart' },
        { text: 'API', url: '/docs/api' },
        { text: 'Examples', url: '/docs/examples' },
        ...(base.links ?? []),
      ]}
    >
      {children}
    </HomeLayout>
  );
}
