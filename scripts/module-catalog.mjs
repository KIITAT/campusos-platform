import { existsSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = resolve(import.meta.dirname, '..')
const escape = (value) => String(value ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ')

export function moduleReference(plugins) {
  const lines = [
    '# Module feature and interface reference', '',
    'Generated from the current plugin manifests, page declarations and OpenAPI fragments.',
    'Page roles are navigation gates, not a substitute for the operation’s per-record authorization.',
    'Every endpoint below has a route declaration checked by the central API-contract suite.',
    'For test procedures use [module workflows](../testing/modules.md); for user-facing background see [features](../../features.md).', '',
    '| Module | Version | Pages | API routes | Dependencies |', '|---|---|---:|---:|---|',
    ...plugins.map((plugin) => `| [${escape(plugin.manifest.name)}](#${plugin.manifest.id}) | ${plugin.manifest.version} | ${plugin.pages?.length ?? 0} | ${plugin.routes.length} | ${plugin.manifest.dependsOn.join(', ') || 'None'} |`), '',
  ]
  for (const plugin of plugins) {
    const { manifest } = plugin
    lines.push(`<a id="${manifest.id}"></a>`, `## ${manifest.name}`, '', escape(manifest.description), '',
      `Module roles: ${manifest.rolesWithAccess.map((role) => `\`${role}\``).join(', ')}.`,
      `Source: \`campusos-platform/packages/modules/${manifest.id}/\`.`, '',
      '### Screens', '', '| Path | Page | Roles |', '|---|---|---|',
      ...(plugin.pages ?? []).map((page) => `| \`/m/${manifest.id}${page.path === '/' ? '' : page.path}\` | ${escape(page.title)} | ${page.roles.join(', ')} |`), '',
      '### Operations', '', '| Method and path | Operation | Body fields / query parameters |', '|---|---|---|')
    for (const route of plugin.routes) {
      const path = manifest.apiBasePath + route.path
      const operation = plugin.openapiPaths[path]?.[route.method.toLowerCase()] ?? {}
      const body = operation.requestBody?.content?.['application/json']?.schema
      const shape = body?.shape ?? body?.properties ?? {}
      const fields = Object.keys(shape).map((key) => `\`${key}\``)
      const query = (operation.parameters ?? []).map((parameter) => `\`${parameter.name}\` (${parameter.in})`)
      lines.push(`| \`${route.method} ${path}\` | ${escape(operation.summary ?? 'See operation implementation')}${route.raw ? ' (binary response)' : ''} | ${[...fields, ...query].join(', ') || 'See runtime OpenAPI schema'} |`)
    }
    if (plugin.jobs?.length) lines.push('', '### Background jobs', '', ...plugin.jobs.map((job) => `- \`${job.kind}\`: ${job.daily ? 'daily scheduled' : 'explicitly queued'}; roles ${job.roles.join(', ')}.`))
    lines.push('')
  }
  return `${lines.join('\n')}\n`
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const directory = join(root, 'packages/modules')
  const ids = readdirSync(directory).filter((name) => existsSync(join(directory, name, 'plugin.ts'))).sort()
  const plugins = []
  for (const id of ids) plugins.push((await import(pathToFileURL(join(directory, id, 'plugin.ts')).href)).plugin)
  process.stdout.write(moduleReference(plugins))
}
