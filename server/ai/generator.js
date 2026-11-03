/**
 * Test-case generation from an OpenAPI spec, a cURL command, or a plain-English
 * description. OpenAPI (JSON) and cURL have deterministic converters that work
 * offline; the AI provider is used for descriptions and, when enabled, for richer
 * generation (negative cases, YAML specs). All paths return drafts in the same
 * shape the import endpoint accepts.
 */
const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];
const MAX_OPERATIONS = 100;

export class GenerationError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

// ------------------------------------------------------------------ OpenAPI

function resolveRef(ref, root) {
  if (!ref?.startsWith('#/')) return {};
  return ref
    .slice(2)
    .split('/')
    .reduce((node, key) => node?.[key.replace(/~1/g, '/').replace(/~0/g, '~')], root) ?? {};
}

/** Produce an example value for a JSON Schema (OpenAPI 2/3 flavour). */
export function exampleFromSchema(schema, root, depth = 0) {
  if (!schema || depth > 6) return null;
  if (schema.$ref) return exampleFromSchema(resolveRef(schema.$ref, root), root, depth + 1);
  if (schema.example !== undefined) return schema.example;
  if (schema.default !== undefined) return schema.default;
  if (schema.enum?.length) return schema.enum[0];
  if (schema.allOf) return Object.assign({}, ...schema.allOf.map((s) => exampleFromSchema(s, root, depth + 1) ?? {}));
  if (schema.oneOf || schema.anyOf) return exampleFromSchema((schema.oneOf ?? schema.anyOf)[0], root, depth + 1);
  const type = Array.isArray(schema.type) ? schema.type.find((t) => t !== 'null') : schema.type;
  if (type === 'object' || (!type && schema.properties)) {
    const out = {};
    for (const [key, prop] of Object.entries(schema.properties ?? {})) {
      if (prop.readOnly) continue;
      out[key] = exampleFromSchema(prop, root, depth + 1);
    }
    return out;
  }
  if (type === 'array') return [exampleFromSchema(schema.items, root, depth + 1)];
  if (type === 'integer') return schema.minimum ?? 1;
  if (type === 'number') return schema.minimum ?? 1.5;
  if (type === 'boolean') return true;
  if (type === 'string') {
    return (
      {
        email: 'user@example.com',
        'date-time': '2026-01-01T00:00:00Z',
        date: '2026-01-01',
        uuid: '00000000-0000-4000-8000-000000000001',
        uri: 'https://example.com',
        password: 'P@ssw0rd!',
      }[schema.format] ?? 'string'
    );
  }
  return null;
}

const deref = (node, root) => (node?.$ref ? resolveRef(node.$ref, root) : node);

function responseSchema(response, root) {
  const r = deref(response, root);
  if (!r) return null;
  if (r.content) {
    const media = r.content['application/json'] ?? Object.entries(r.content).find(([k]) => k.includes('json'))?.[1];
    return media?.schema ? deref(media.schema, root) : null;
  }
  return r.schema ? deref(r.schema, root) : null; // Swagger 2
}

export function testsFromOpenApi(spec) {
  if (!spec || typeof spec !== 'object' || !spec.paths) throw new GenerationError('This does not look like an OpenAPI/Swagger document (no "paths").');
  const warnings = [];
  const globalSecurity = spec.security?.length > 0;
  const serverPath = spec.servers?.[0]?.url ?? spec.basePath;
  if (serverPath && serverPath !== '/') warnings.push(`Paths are relative to {{baseUrl}}. The spec's server/base path is "${serverPath}", so include it in baseUrl if needed.`);

  const tests = [];
  let usesToken = false;
  for (const [path, item] of Object.entries(spec.paths)) {
    const shared = item.parameters ?? [];
    for (const method of METHODS) {
      const op = item[method];
      if (!op) continue;
      if (tests.length >= MAX_OPERATIONS) {
        warnings.push(`Only the first ${MAX_OPERATIONS} operations were converted.`);
        break;
      }
      const params = [...shared, ...(op.parameters ?? [])].map((p) => deref(p, spec));
      let url = path;
      const query = [];
      const headers = [];
      for (const p of params) {
        const example = p.example ?? exampleFromSchema(p.schema ?? p, spec) ?? (p.in === 'path' ? 1 : 'value');
        if (p.in === 'path') url = url.replace(`{${p.name}}`, encodeURIComponent(String(example)));
        else if (p.in === 'query' && p.required) query.push({ key: p.name, value: String(example) });
        else if (p.in === 'header' && p.required && p.name.toLowerCase() !== 'authorization') headers.push({ key: p.name, value: String(example) });
      }
      const secured = op.security ? op.security.length > 0 : globalSecurity;
      if (secured) {
        headers.push({ key: 'Authorization', value: 'Bearer {{token}}' });
        usesToken = true;
      }

      let body = '';
      const reqBody = deref(op.requestBody, spec);
      const bodySchema = reqBody?.content?.['application/json']?.schema ?? params.find((p) => p.in === 'body')?.schema;
      if (bodySchema) body = JSON.stringify(exampleFromSchema(bodySchema, spec), null, 2);

      const codes = Object.keys(op.responses ?? {});
      const success = codes.find((c) => /^2\d\d$/.test(c));
      const assertions = [success ? { type: 'status', operator: 'equals', expected: success, target: '' } : { type: 'status', operator: 'lessThan', expected: '400', target: '' }];
      const schema = success ? responseSchema(op.responses[success], spec) : null;
      if (schema) {
        const type = schema.type ?? (schema.properties ? 'object' : undefined);
        if (type === 'array') assertions.push({ type: 'jsonPath', target: '$', operator: 'isType', expected: 'array' });
        else if (type === 'object') {
          const props = schema.required?.length ? schema.required : Object.keys(schema.properties ?? {});
          for (const prop of props.slice(0, 3)) assertions.push({ type: 'jsonPath', target: prop, operator: 'exists', expected: '' });
        }
      }

      const upper = method.toUpperCase();
      tests.push({
        name: (op.summary || op.operationId || `${upper} ${path}`).slice(0, 200),
        description: (op.description ?? `${upper} ${path}`).slice(0, 500),
        type: 'http',
        tags: [...new Set([...(op.tags ?? []).map((t) => String(t).toLowerCase()), 'generated'])].slice(0, 6),
        priority: 'medium',
        config: { method: upper, url: `{{baseUrl}}${url}`, query, headers, bodyType: body ? 'json' : 'none', body, assertions },
      });
    }
  }
  if (!tests.length) throw new GenerationError('No operations found in the spec.');
  if (usesToken) warnings.push('Secured endpoints use "Authorization: Bearer {{token}}". Add a token variable to your environment.');
  return { tests, warnings };
}

// --------------------------------------------------------------------- cURL

/** Split a shell command into arguments, honouring quotes and line continuations (\ and ^). */
export function shellSplit(command) {
  const text = command.replace(/\\\r?\n/g, ' ').replace(/\^\r?\n/g, ' ');
  const args = [];
  let current = '';
  let quote = null;
  let inArg = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === '\\' && quote === '"' && i + 1 < text.length && '"\\$`'.includes(text[i + 1])) current += text[++i];
      else current += ch;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      inArg = true;
    } else if (/\s/.test(ch)) {
      if (inArg) args.push(current);
      current = '';
      inArg = false;
    } else if (ch === '\\' && i + 1 < text.length) {
      current += text[++i];
      inArg = true;
    } else {
      current += ch;
      inArg = true;
    }
  }
  if (quote) throw new GenerationError('Unbalanced quotes in the cURL command.');
  if (inArg) args.push(current);
  return args;
}

export function testFromCurl(command, { baseUrl } = {}) {
  const args = shellSplit(command.trim());
  if (!args.length || !/^curl(\.exe)?$/i.test(args[0])) throw new GenerationError('Paste a command that starts with "curl".');
  let method;
  let url;
  const headers = [];
  const data = [];
  let json = false;
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    const next = () => args[++i];
    if (a === '-X' || a === '--request') method = next()?.toUpperCase();
    else if (a.startsWith('-X') && a.length > 2) method = a.slice(2).toUpperCase();
    else if (a === '-H' || a === '--header') {
      const h = next() ?? '';
      const idx = h.indexOf(':');
      if (idx > 0) headers.push({ key: h.slice(0, idx).trim(), value: h.slice(idx + 1).trim() });
    } else if (['-d', '--data', '--data-raw', '--data-binary', '--data-ascii', '--data-urlencode'].includes(a)) data.push(next() ?? '');
    else if (a === '--json') {
      data.push(next() ?? '');
      json = true;
    } else if (a === '-u' || a === '--user') headers.push({ key: 'Authorization', value: `Basic ${Buffer.from(next() ?? '').toString('base64')}` });
    else if (a === '--url') url = next();
    else if (a === '-I' || a === '--head') method = 'HEAD';
    else if (['-o', '--output', '-A', '--user-agent', '-e', '--referer', '-m', '--max-time', '--connect-timeout', '-b', '--cookie'].includes(a)) {
      const v = next();
      if (a === '-A' || a === '--user-agent') headers.push({ key: 'User-Agent', value: v });
      if (a === '-b' || a === '--cookie') headers.push({ key: 'Cookie', value: v });
    } else if (!a.startsWith('-') && !url) url = a;
  }
  if (!url) throw new GenerationError('No URL found in the cURL command.');
  if (!/^https?:\/\//i.test(url)) url = `http://${url}`;
  method ??= data.length ? 'POST' : 'GET';

  const warnings = [];
  let finalUrl = url;
  // localhost and 127.0.0.1 name the same server; compare them as equal.
  const loopback = (u) => u.replace(/^(https?:\/\/)(localhost|127\.0\.0\.1|\[::1\])(?=[:/]|$)/i, '$1127.0.0.1');
  if (baseUrl && loopback(url).startsWith(loopback(baseUrl))) finalUrl = `{{baseUrl}}${loopback(url).slice(loopback(baseUrl).length)}`;
  else {
    try {
      const parsed = new URL(url);
      warnings.push(`URL kept as-is. Replace "${parsed.origin}" with {{baseUrl}} to make the test environment-aware.`);
    } catch {
      throw new GenerationError(`Invalid URL "${url}".`);
    }
  }

  const body = data.join('&');
  let bodyType = 'none';
  if (body) {
    try {
      JSON.parse(body);
      bodyType = 'json';
    } catch {
      bodyType = json ? 'json' : 'text';
    }
  }
  if (json && !headers.some((h) => h.key.toLowerCase() === 'content-type')) headers.push({ key: 'Content-Type', value: 'application/json' });
  if (bodyType === 'text' && !headers.some((h) => h.key.toLowerCase() === 'content-type')) {
    headers.push({ key: 'Content-Type', value: 'application/x-www-form-urlencoded' });
  }

  let pathLabel = finalUrl;
  try {
    pathLabel = new URL(url).pathname;
  } catch {
    /* keep */
  }
  return {
    tests: [
      {
        name: `${method} ${pathLabel}`.slice(0, 200),
        description: 'Imported from a cURL command.',
        type: 'http',
        tags: ['generated', 'curl'],
        priority: 'medium',
        config: {
          method,
          url: finalUrl,
          query: [],
          headers,
          bodyType,
          body: bodyType === 'json' ? JSON.stringify(JSON.parse(body), null, 2) : body,
          assertions: [
            { type: 'status', operator: 'lessThan', expected: '400', target: '' },
            { type: 'responseTime', operator: 'lessThan', expected: '2000', target: '' },
          ],
        },
      },
    ],
    warnings,
  };
}

// ----------------------------------------------------------------- AI output

/** Convert the AI provider's structured output into importable drafts. */
export function draftsFromAI(generated) {
  return generated.tests.map((t) => {
    const body = t.body?.trim() ?? '';
    let bodyType = 'none';
    if (body) {
      try {
        JSON.parse(body.replace(/\{\{\s*[$\w.-]+\s*\}\}/g, '0'));
        bodyType = 'json';
      } catch {
        bodyType = 'text';
      }
    }
    return {
      name: t.name.slice(0, 200),
      description: t.description ?? '',
      type: 'http',
      tags: [...new Set([...(t.tags ?? []).map((x) => x.toLowerCase()), 'generated', 'ai'])].slice(0, 8),
      priority: ['low', 'medium', 'high'].includes(t.priority) ? t.priority : 'medium',
      config: {
        method: t.method.toUpperCase(),
        url: t.url,
        query: t.query ?? [],
        headers: t.headers ?? [],
        bodyType,
        body,
        assertions: (t.assertions ?? []).map((a) => ({ ...a, target: a.target ?? '', expected: a.expected ?? '' })),
      },
    };
  });
}
