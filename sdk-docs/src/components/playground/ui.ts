// Shared button styles. Buttons stay on the navy/foreground scale: blue is kept
// for links and the focus ring only.
const btn =
  'inline-flex items-center justify-center gap-1.5 rounded-lg px-3.5 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fd-ring disabled:cursor-not-allowed disabled:opacity-50';
export const primaryBtn = `${btn} bg-fd-foreground text-fd-background hover:bg-fd-foreground/85`;
export const secondaryBtn = `${btn} border bg-fd-secondary text-fd-secondary-foreground hover:bg-fd-accent`;
