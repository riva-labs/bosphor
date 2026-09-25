import defaultMdxComponents from 'fumadocs-ui/mdx';
import { Card, Cards } from 'fumadocs-ui/components/card';
import { Callout } from 'fumadocs-ui/components/callout';
import { Tab, Tabs } from 'fumadocs-ui/components/tabs';
import { Step, Steps } from 'fumadocs-ui/components/steps';
import { FaqStructuredData } from '@/components/structured-data';
import { Mermaid } from '@/components/mermaid';
import { AgentPrompt } from '@/components/agent-prompt';
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
    // FAQ pages emit FAQPage JSON-LD via this component.
    FaqStructuredData,
    // Client-rendered Mermaid diagrams.
    Mermaid,
    // Copyable prompt with "open in Claude / ChatGPT / Gemini" links.
    AgentPrompt,
    ...components,
  } satisfies MDXComponents;
}

export const useMDXComponents = getMDXComponents;

declare global {
  type MDXProvidedComponents = ReturnType<typeof getMDXComponents>;
}
