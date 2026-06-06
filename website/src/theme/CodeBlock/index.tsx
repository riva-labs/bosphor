import React, { useRef } from 'react';
import CodeBlock from '@theme-original/CodeBlock';
import type { WrapperProps } from '@docusaurus/types';
import OpenInAgentButton from '@site/src/components/OpenInAgentButton';
import styles from './styles.module.css';

type Props = WrapperProps<typeof CodeBlock>;

export default function CodeBlockWrapper(props: Props): React.ReactElement {
  const { children, className, metastring } = props as Props & {
    className?: string;
    metastring?: string;
  };

  const lang = className?.replace(/^language-/, '') || '';
  const code =
    typeof children === 'string'
      ? children.trim()
      : '';

  const showButton = code.length > 0 && !metastring?.includes('no-agent');

  return (
    <div className={styles.wrapper}>
      <CodeBlock {...props} />
      {showButton && (
        <div className={styles.buttonRow}>
          <OpenInAgentButton code={code} language={lang} />
        </div>
      )}
    </div>
  );
}
