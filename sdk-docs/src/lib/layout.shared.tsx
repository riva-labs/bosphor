import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';
import Image from 'next/image';
import { Activity, Package } from 'lucide-react';
import { links } from './shared';

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: (
        <>
          <Image
            src="/bosphor-mark.png"
            alt=""
            width={22}
            height={22}
            className="rounded-sm"
          />
          <span className="font-display text-[15px] font-bold tracking-tight">Bosphor</span>
          <span className="rounded border px-1.5 py-px font-mono text-[10px] font-medium uppercase tracking-wider text-fd-muted-foreground">
            Docs
          </span>
        </>
      ),
    },
    githubUrl: links.github,
    links: [
      {
        type: 'icon',
        label: 'npm package',
        text: 'npm',
        url: links.npm,
        icon: <Package />,
        external: true,
      },
      {
        type: 'icon',
        label: 'System status',
        text: 'Status',
        url: links.status,
        icon: <Activity />,
        external: true,
      },
    ],
  };
}
