import {type ReactNode, useEffect, useState} from 'react';
import Layout from '@theme/Layout';
import Heading from '@theme/Heading';
import Link from '@docusaurus/Link';

// Public relayer API (Cloudflare tunnel). Real data only: the count renders
// only when the API returns one, never a fabricated number.
const API = 'https://api.bosphor.xyz';

type Status = {kind: 'idle' | 'ok' | 'err'; text: string};

export default function Waitlist(): ReactNode {
  const [email, setEmail] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [status, setStatus] = useState<Status>({kind: 'idle', text: ''});
  const [count, setCount] = useState<number | null>(null);

  useEffect(() => {
    fetch(`${API}/public/waitlist/count`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d && typeof d.count === 'number') setCount(d.count);
      })
      .catch(() => {});
  }, []);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const value = email.trim();
    if (!value) return;
    setSubmitting(true);
    setStatus({kind: 'idle', text: 'Submitting…'});
    try {
      const res = await fetch(`${API}/public/waitlist`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({email: value, source: 'docs-waitlist'}),
      });
      const body = await res.json().catch(() => ({}));
      if (res.status === 200 && body.ok) {
        setStatus({
          kind: 'ok',
          text: body.created ? "You're on the list. We'll be in touch." : "You're already on the list.",
        });
        setEmail('');
        setCount((c) => (body.created && c !== null ? c + 1 : c));
      } else if (res.status === 400) {
        setStatus({kind: 'err', text: 'Please enter a valid email address.'});
      } else {
        setStatus({kind: 'err', text: 'Something went wrong. Please try again later.'});
      }
    } catch {
      setStatus({kind: 'err', text: 'Network error. Please try again.'});
    } finally {
      setSubmitting(false);
    }
  }

  const statusColor =
    status.kind === 'ok'
      ? 'var(--ifm-color-success)'
      : status.kind === 'err'
        ? 'var(--ifm-color-danger)'
        : 'var(--bosphor-text-muted, var(--ifm-color-emphasis-600))';

  return (
    <Layout
      title="Early Access"
      description="Join the Bosphor developer waitlist. Making Permanence Portable.">
      <main className="container margin-vert--xl">
        <div className="row">
          <div className="col col--6 col--offset-3">
            <p
              style={{
                textTransform: 'uppercase',
                letterSpacing: '0.08em',
                fontSize: '0.8rem',
                fontWeight: 600,
                color: 'var(--ifm-color-primary)',
                marginBottom: '0.5rem',
              }}>
              Making Permanence Portable
            </p>
            <Heading as="h1" className="hero__title">
              Get early access to Bosphor
            </Heading>
            <p style={{fontSize: '1.05rem', color: 'var(--bosphor-text-muted, inherit)'}}>
              Cross-chain storage intent routing to Walrus. Join the developer waitlist and we
              will reach out when the SDK opens up.
            </p>

            <form onSubmit={onSubmit} style={{display: 'flex', gap: '0.75rem', flexWrap: 'wrap', marginTop: '1.5rem'}}>
              <input
                type="email"
                required
                autoComplete="email"
                placeholder="you@yourteam.dev"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="button button--outline"
                style={{
                  flex: '1 1 260px',
                  textAlign: 'left',
                  cursor: 'text',
                  fontWeight: 400,
                  padding: '0 1rem',
                  height: '2.75rem',
                }}
              />
              <button type="submit" className="button button--primary button--lg" disabled={submitting}>
                {submitting ? 'Joining…' : 'Join the waitlist'}
              </button>
            </form>

            <p role="status" aria-live="polite" style={{minHeight: '1.5rem', marginTop: '1rem', color: statusColor}}>
              {status.text}
            </p>

            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                marginTop: '1.5rem',
                fontSize: '0.9rem',
                color: 'var(--bosphor-text-muted, var(--ifm-color-emphasis-600))',
              }}>
              <span>{count !== null && count > 0 ? `${count} developer${count === 1 ? '' : 's'} waitlisted` : ''}</span>
              <Link to="https://status.bosphor.xyz">System status →</Link>
            </div>
          </div>
        </div>
      </main>
    </Layout>
  );
}
