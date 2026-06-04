import type {ReactNode} from 'react';
import Link from '@docusaurus/Link';
import Layout from '@theme/Layout';
import Heading from '@theme/Heading';

export default function NotFound(): ReactNode {
  return (
    <Layout title="Page Not Found">
      <main className="container margin-vert--xl">
        <div className="row">
          <div className="col col--6 col--offset-3">
            <Heading as="h1" className="hero__title">
              Page Not Found
            </Heading>
            <p>
              The page you are looking for does not exist. It may have been
              moved or removed.
            </p>
            <p>Here are some helpful links to get you back on track:</p>
            <ul>
              <li>
                <Link to="/">Introduction</Link>
              </li>
              <li>
                <Link to="/quickstart">Quickstart</Link>
              </li>
              <li>
                <Link to="/architecture">Architecture</Link>
              </li>
            </ul>
          </div>
        </div>
      </main>
    </Layout>
  );
}
