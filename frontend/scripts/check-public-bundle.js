import { gzipSync } from 'node:zlib'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const manifestPath = resolve(root, 'dist/.vite/manifest.json')
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
const publicRoutes = {
  '/': 'src/HomePage.jsx',
  '/search': 'src/SearchPage.jsx',
  '/categories': 'src/CategoryPage.jsx',
  '/category/:id': 'src/CategoryPage.jsx',
  '/checkout/soon': null,
  '/login': 'src/AuthScreen.jsx',
  '/listing/:id': 'src/PublicListingDetail.jsx',
}
const nonPublicRoutes = new Set([
  '/checkout/:listingId',
  '/orders',
  '/orders/:orderId',
  '/orders/:orderId/payment-return',
])
const privateModules = new Set([
  'src/CheckoutPage.jsx',
  'src/OrderPage.jsx',
  'src/MyOrdersPage.jsx',
  'src/PaymentReturnPage.jsx',
  'src/AccountWorkspace.jsx',
  'src/ListingWorkspace.jsx',
  'src/ModerationWorkspace.jsx',
  'src/WorkspaceFrame.jsx',
])
const maxBytes = 200 * 1024

for (const route of nonPublicRoutes) {
  if (Object.hasOwn(publicRoutes, route)) {
    throw new Error(`${route} is registered as both public and non-public.`)
  }
}

function findEntry(source) {
  const entry = Object.entries(manifest).find(([key, value]) => key === source || value.src === source)
  if (!entry) throw new Error(`Could not find ${source} in the Vite build manifest.`)
  return entry[0]
}

const appEntry = findEntry('index.html')

function collectStaticGraph(entryKeys) {
  const visited = new Set()
  const pending = [...entryKeys]
  while (pending.length) {
    const key = pending.pop()
    if (visited.has(key)) continue
    visited.add(key)
    const entry = manifest[key]
    if (!entry) throw new Error(`Missing manifest entry: ${key}`)
    for (const imported of entry.imports || []) pending.push(imported)
  }
  return visited
}

function gzipBytes(entries) {
  const files = new Set()
  for (const key of entries) {
    const file = manifest[key].file
    if (file.endsWith('.js')) files.add(file)
  }
  return [...files].reduce((total, file) => {
    return total + gzipSync(readFileSync(resolve(root, 'dist', file)), { level: 9 }).byteLength
  }, 0)
}

let largestRoute = 0
for (const [route, source] of Object.entries(publicRoutes)) {
  const entries = collectStaticGraph(source ? [appEntry, findEntry(source)] : [appEntry])
  const includedSources = [...entries].map((key) => manifest[key].src).filter(Boolean)
  const leakedPrivateModule = includedSources.find((module) => privateModules.has(module))
  if (leakedPrivateModule) {
    throw new Error(`${route} statically includes private module ${leakedPrivateModule}.`)
  }
  const compressedBytes = gzipBytes(entries)
  largestRoute = Math.max(largestRoute, compressedBytes)
  console.log(`${route}: ${(compressedBytes / 1024).toFixed(1)} KB gzip`)
  if (compressedBytes > maxBytes) {
    throw new Error(`${route} exceeds the 200 KB gzip public-route budget.`)
  }
}

console.log(`Largest public route: ${(largestRoute / 1024).toFixed(1)} KB gzip (budget: 200 KB)`)
