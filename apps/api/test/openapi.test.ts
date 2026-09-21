import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { parse } from 'yaml'

test('OpenAPI references resolve and all terminal routes have response contracts', async () => {
  const spec = parse(await readFile(new URL('../../../api/openapi.yaml', import.meta.url), 'utf8')) as Record<string, unknown>
  function walk(value: unknown) {
    if (!value || typeof value !== 'object') return
    for (const [key, nested] of Object.entries(value)) {
      if (key === '$ref') {
        assert.equal(typeof nested, 'string')
        assert((nested as string).startsWith('#/'))
        let target: unknown = spec
        for (const segment of (nested as string).slice(2).split('/')) target = (target as Record<string, unknown>)[segment]
        assert(target, `Missing schema ${nested}`)
      } else walk(nested)
    }
  }
  walk(spec)
  const paths = spec.paths as Record<string, Record<string, { responses?: unknown }>>
  const source = await readFile(new URL('../src/terminal-auth/routes.ts', import.meta.url), 'utf8')
  for (const [, method, route] of source.matchAll(/router\.(get|post)\('([^']+)'/g)) {
    const path = route.replace(/:([a-zA-Z]+)/g, '{$1}')
    assert(paths[path]?.[method]?.responses, `Missing ${method.toUpperCase()} ${path}`)
  }
})
