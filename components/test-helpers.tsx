import { JSDOM } from 'jsdom'

// Node's test runner has no DOM. Preloaded by tests/dom-setup.ts before any
// *.test.tsx file imports React/Testing Library, so `render()` has a
// document to mount into.
export function installDom(): void {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
  const { window } = dom
  global.window = window as unknown as Window & typeof globalThis
  global.document = window.document
  global.HTMLElement = window.HTMLElement
  global.Node = window.Node
  // next/link's intersection-observer prefetch code references `self` directly.
  global.self = global.window
  // Node 24 ships a read-only global `navigator` getter; jsdom's needs to replace it.
  Object.defineProperty(global, 'navigator', { value: window.navigator, configurable: true })
  // React Testing Library reads act() support off this flag.
  ;(global as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
}
