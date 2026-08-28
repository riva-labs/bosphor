import { createGenerator } from 'fumadocs-typescript';
import { AutoTypeTable } from 'fumadocs-typescript/ui';
import path from 'node:path';
import type { ComponentProps } from 'react';

// Runs at build time (static export): a fumadocs-typescript generator bound to
// the @bosphor/sdk TypeScript sources, so the API reference tables are pulled
// live from the SDK types, the same mechanism sdk.mystenlabs.com uses.
const repoRoot = path.resolve(process.cwd(), '..');

const generator = createGenerator({
  tsconfigPath: path.join(repoRoot, 'sdk', 'tsconfig.json'),
});

// `path` props in MDX resolve against the repo root, e.g.
// <AutoTypeTable path="sdk/src/types.ts" name="StoreResult" />.
export function SdkTypeTable(props: Omit<ComponentProps<typeof AutoTypeTable>, 'generator'>) {
  return <AutoTypeTable {...props} generator={generator} options={{ basePath: repoRoot }} />;
}
