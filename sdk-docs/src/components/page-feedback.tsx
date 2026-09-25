import { Pencil, ThumbsDown, ThumbsUp } from 'lucide-react';
import { gitConfig, siteUrl } from '@/lib/shared';

const repo = `https://github.com/${gitConfig.user}/${gitConfig.repo}`;

/** A prefilled "new issue" link: no backend, the feedback lands in GitHub Issues. */
function issueUrl(title: string, pageTitle: string, pageUrl: string, helpful: boolean) {
  const body = [
    `Page: [${pageTitle}](${siteUrl}${pageUrl})`,
    '',
    helpful ? 'This page helped. What worked well:' : 'This page did not help. What was missing or wrong:',
    '',
    '',
  ].join('\n');
  const params = new URLSearchParams({ title, body, labels: 'docs' });
  return `${repo}/issues/new?${params.toString()}`;
}

/**
 * Bottom-of-page row: "Edit this page on GitHub" and a "Was this page helpful?"
 * prompt whose answers open a prefilled GitHub issue.
 */
export function PageFeedback({
  title,
  url,
  path,
}: {
  /** Page title. */
  title: string;
  /** Page URL on the site, e.g. /docs/quickstart. */
  url: string;
  /** Source file path relative to content/docs. */
  path: string;
}) {
  const editUrl = `${repo}/edit/${gitConfig.branch}/sdk-docs/content/docs/${path}`;
  const button =
    'inline-flex items-center gap-1.5 rounded-md border bg-fd-card px-2.5 py-1 text-xs font-medium text-fd-foreground transition-colors hover:bg-fd-accent';

  return (
    <div className="not-prose mt-10 flex flex-wrap items-center justify-between gap-4 border-t pt-5 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-fd-muted-foreground">Was this page helpful?</span>
        <a
          className={button}
          href={issueUrl(`Docs feedback: ${title} (helpful)`, title, url, true)}
          target="_blank"
          rel="noreferrer noopener"
        >
          <ThumbsUp className="size-3.5" aria-hidden />
          Yes
        </a>
        <a
          className={button}
          href={issueUrl(`Docs feedback: ${title} (needs work)`, title, url, false)}
          target="_blank"
          rel="noreferrer noopener"
        >
          <ThumbsDown className="size-3.5" aria-hidden />
          No
        </a>
      </div>
      <a
        href={editUrl}
        target="_blank"
        rel="noreferrer noopener"
        className="inline-flex items-center gap-1.5 text-fd-primary hover:underline"
      >
        <Pencil className="size-3.5" aria-hidden />
        Edit this page on GitHub
      </a>
    </div>
  );
}
