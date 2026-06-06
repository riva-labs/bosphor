export default function Footer() {
  const year = new Date().getFullYear();

  return (
    <footer className="border-t border-surface-2 bg-bg-deep" role="contentinfo">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-8">
        <div className="flex flex-col sm:flex-row items-center justify-between gap-4">
          <p className="text-sm text-text-muted">
            &copy; {year} Bosphor. All rights reserved.
          </p>
          <p className="text-sm text-text-muted">
            Built by{" "}
            <a
              href="https://github.com/riva-labs"
              target="_blank"
              rel="noopener noreferrer"
              className="text-text-body hover:text-text-heading transition-colors"
            >
              Riva Labs
            </a>
          </p>
        </div>
      </div>
    </footer>
  );
}
