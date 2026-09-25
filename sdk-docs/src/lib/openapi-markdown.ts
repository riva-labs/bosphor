import type { OpenAPIPageData } from 'fumadocs-openapi/server';

/**
 * Plain Markdown for a generated API reference page, used by llms.txt,
 * llms-full.txt and the per-page "copy Markdown" route. The rendered page is a
 * React component, so its text is rebuilt here from the same spec.
 */

type Json = Record<string, unknown>;

function isObject(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function makeResolver(doc: Json) {
  return function resolve<T = Json>(value: unknown, depth = 0): T {
    if (depth > 20 || !isObject(value) || typeof value.$ref !== 'string') return value as T;
    const ref = value.$ref;
    if (!ref.startsWith('#/')) return value as T;
    let target: unknown = doc;
    for (const part of ref.slice(2).split('/')) {
      if (!isObject(target)) return value as T;
      target = target[part.replace(/~1/g, '/').replace(/~0/g, '~')];
    }
    // Sibling keys (e.g. a local description) override the referenced ones.
    const { $ref: _ref, ...siblings } = value;
    return resolve<T>(isObject(target) ? { ...target, ...siblings } : target, depth + 1);
  };
}

function schemaType(schema: Json, resolve: ReturnType<typeof makeResolver>): string {
  const s = resolve(schema);
  if (Array.isArray(s.enum)) return s.enum.map((v) => `\`${String(v)}\``).join(', ');
  if (Array.isArray(s.oneOf)) return s.oneOf.map((o) => schemaType(o as Json, resolve)).join(' or ');
  if (s.type === 'array' && isObject(s.items)) return `${schemaType(s.items, resolve)}[]`;
  if (typeof s.type === 'string') return s.type;
  return 'object';
}

function cell(text: unknown): string {
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .replace(/\|/g, '\\|')
    .trim();
}

function firstExample(media: Json, resolve: ReturnType<typeof makeResolver>): unknown {
  if (media.example !== undefined) return media.example;
  if (isObject(media.examples)) {
    const first = Object.values(media.examples)[0];
    if (first !== undefined) return resolve(first).value;
  }
  return undefined;
}

function jsonBlock(value: unknown): string {
  return ['```json', JSON.stringify(value, null, 2), '```'].join('\n');
}

export function operationToMarkdown(data: OpenAPIPageData): string {
  const doc = data.getSchema().bundled as unknown as Json;
  const resolve = makeResolver(doc);
  const item = data.getOpenAPIPageProps().operations?.[0];
  if (!item) return data.description ?? '';

  const paths = resolve(doc.paths);
  const pathItem = resolve(paths[item.path]);
  const op = resolve(pathItem[item.method]);
  const servers = (doc.servers as Json[] | undefined) ?? [];
  const base = typeof servers[0]?.url === 'string' ? (servers[0].url as string) : '';
  const out: string[] = [];

  out.push(`\`${item.method.toUpperCase()} ${base}${item.path}\``);
  if (typeof op.description === 'string') out.push(op.description.trim());

  const params = [...((op.parameters as unknown[]) ?? []), ...((pathItem.parameters as unknown[]) ?? [])].map(
    (p) => resolve(p),
  );
  if (params.length > 0) {
    out.push('## Parameters');
    const rows = ['| Name | In | Type | Required | Description |', '|------|----|------|----------|-------------|'];
    for (const p of params) {
      rows.push(
        `| \`${cell(p.name)}\` | ${cell(p.in)} | ${cell(schemaType((p.schema as Json) ?? {}, resolve))} | ${
          p.required ? 'yes' : 'no'
        } | ${cell(p.description)} |`,
      );
    }
    out.push(rows.join('\n'));
  }

  if (op.requestBody) {
    const body = resolve(op.requestBody);
    const content = resolve(body.content);
    for (const [mediaType, rawMedia] of Object.entries(content)) {
      const media = resolve(rawMedia);
      out.push(`## Request body (\`${mediaType}\`)`);
      if (typeof body.description === 'string') out.push(body.description.trim());
      const schema = resolve((media.schema as Json) ?? {});
      const props = isObject(schema.properties) ? schema.properties : undefined;
      if (props) {
        const required = new Set((schema.required as string[]) ?? []);
        const rows = ['| Field | Type | Required | Description |', '|-------|------|----------|-------------|'];
        for (const [name, raw] of Object.entries(props)) {
          const prop = resolve(raw);
          rows.push(
            `| \`${name}\` | ${cell(schemaType(prop, resolve))} | ${required.has(name) ? 'yes' : 'no'} | ${cell(
              prop.description,
            )} |`,
          );
        }
        out.push(rows.join('\n'));
      }
      const example = firstExample(media, resolve);
      if (example !== undefined) out.push('Example:', jsonBlock(example));
    }
  }

  const responses = resolve(op.responses ?? {});
  const statuses = Object.keys(responses);
  if (statuses.length > 0) {
    out.push('## Responses');
    for (const status of statuses) {
      const res = resolve(responses[status]);
      out.push(`### ${status}`);
      if (typeof res.description === 'string') out.push(res.description.trim());
      const content = isObject(res.content) ? resolve(res.content) : {};
      const json = content['application/json'];
      if (json) {
        const example = firstExample(resolve(json), resolve);
        if (example !== undefined) out.push(jsonBlock(example));
      }
    }
  }

  return out.join('\n\n');
}
