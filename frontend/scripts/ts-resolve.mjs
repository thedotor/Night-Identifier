// Lets `node --import ./scripts/ts-resolve.mjs scripts/x.check.ts` resolve the app's
// extensionless relative imports (./skyMath) the way the bundler does.
import { register } from 'node:module'
register(
  'data:text/javascript,' +
    encodeURIComponent(`
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
export async function resolve(specifier, context, next) {
  if (specifier.startsWith('.') && !/\.[cm]?[jt]s$/.test(specifier) && context.parentURL) {
    const url = new URL(specifier + '.ts', context.parentURL)
    if (existsSync(fileURLToPath(url))) return next(url.href, context)
  }
  return next(specifier, context)
}`)
)
