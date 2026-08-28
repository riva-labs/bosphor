import defaultMdxComponents from 'fumadocs-ui/mdx';
import { Card, Cards } from 'fumadocs-ui/components/card';
import { Callout } from 'fumadocs-ui/components/callout';
import { Tab, Tabs } from 'fumadocs-ui/components/tabs';
import { Step, Steps } from 'fumadocs-ui/components/steps';
import { SdkTypeTable } from '@/lib/type-table';
import { FaqStructuredData } from '@/components/structured-data';
import type { MDXComponents } from 'mdx/types';

export function getMDXComponents(components?: MDXComponents) {
  return {
    ...defaultMdxComponents,
    Card,
    Cards,
    Callout,
    Tab,
    Tabs,
    Step,
    Steps,
    // API reference: type tables generated from the @bosphor/sdk sources.
    AutoTypeTable: SdkTypeTable,
    // FAQ pages emit FAQPage JSON-LD via this component.
    FaqStructuredData,
    ...components,
  } satisfies MDXComponents;
}

export const useMDXComponents = getMDXComponents;

declare global {
  type MDXProvidedComponents = ReturnType<typeof getMDXComponents>;
}
