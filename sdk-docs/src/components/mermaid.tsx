'use client';

import { useEffect, useId, useRef, useState } from 'react';

// Client-side Mermaid renderer. Mermaid ships a large browser bundle, so it is
// dynamically imported and only runs in the browser (fine for a static export).
// It re-renders when the site theme toggles, reading the `.dark` class that
// Fumadocs' RootProvider sets on <html>.
export function Mermaid({ chart }: { chart: string }) {
  const id = useId().replace(/[^a-zA-Z0-9]/g, '');
  const containerRef = useRef<HTMLDivElement>(null);
  const [svg, setSvg] = useState('');
  const [isDark, setIsDark] = useState(false);

  // Track the current theme from the document class.
  useEffect(() => {
    const read = () => setIsDark(document.documentElement.classList.contains('dark'));
    read();
    const observer = new MutationObserver(read);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const { default: mermaid } = await import('mermaid');
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        fontFamily: 'inherit',
        theme: isDark ? 'dark' : 'default',
        themeVariables: {
          primaryColor: isDark ? '#1f2937' : '#eef4f9',
          primaryBorderColor: '#3a7aaf',
          primaryTextColor: isDark ? '#e5e7eb' : '#1c1c22',
          lineColor: '#3a7aaf',
          fontSize: '14px',
        },
      });

      try {
        const { svg: rendered } = await mermaid.render(`mermaid-${id}`, chart);
        if (!cancelled) setSvg(rendered);
      } catch {
        if (!cancelled) setSvg('');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [chart, isDark, id]);

  return (
    <div
      ref={containerRef}
      className="my-6 flex justify-center overflow-x-auto [&_svg]:h-auto [&_svg]:max-w-full"
      // eslint-disable-next-line react/no-danger
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
