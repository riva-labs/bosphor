import React, {useState} from 'react';
import Footer from '@theme-original/DocItem/Footer';
import type FooterType from '@theme/DocItem/Footer';
import type {WrapperProps} from '@docusaurus/types';

type Props = WrapperProps<typeof FooterType>;

function PageFeedback() {
  const [submitted, setSubmitted] = useState<'yes' | 'no' | null>(null);

  if (submitted) {
    return (
      <div
        style={{
          marginTop: '2rem',
          padding: '1rem 0',
          borderTop: '1px solid var(--ifm-toc-border-color)',
          color: 'var(--ifm-color-secondary-darkest)',
        }}>
        Thanks for your feedback!
      </div>
    );
  }

  return (
    <div
      style={{
        marginTop: '2rem',
        padding: '1rem 0',
        borderTop: '1px solid var(--ifm-toc-border-color)',
        display: 'flex',
        alignItems: 'center',
        gap: '0.75rem',
      }}>
      <span>Was this page helpful?</span>
      <button
        type="button"
        className="button button--sm button--secondary"
        onClick={() => setSubmitted('yes')}>
        Yes
      </button>
      <button
        type="button"
        className="button button--sm button--secondary"
        onClick={() => setSubmitted('no')}>
        No
      </button>
    </div>
  );
}

export default function FooterWrapper(props: Props): React.JSX.Element {
  return (
    <>
      <Footer {...props} />
      <PageFeedback />
    </>
  );
}
