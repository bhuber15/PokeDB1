import { JSDOM } from 'jsdom'

// Node's test runner has no DOM. Preloaded by tests/dom-setup.ts before any
// *.test.tsx file imports React/Testing Library, so `render()` has a
// document to mount into.
export function installDom(): void {
  // pretendToBeVisual gives window a requestAnimationFrame loop, which Base UI
  // transitions schedule against on mount.
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'http://localhost/',
    pretendToBeVisual: true,
  })
  const { window } = dom
  global.window = window as unknown as Window & typeof globalThis
  global.document = window.document
  global.HTMLElement = window.HTMLElement
  global.Node = window.Node
  // Base UI dialogs/popups (via floating-ui) probe these globals directly.
  global.Element = window.Element
  global.SVGElement = window.SVGElement
  global.getComputedStyle = window.getComputedStyle.bind(window)
  global.requestAnimationFrame = window.requestAnimationFrame.bind(window)
  global.cancelAnimationFrame = window.cancelAnimationFrame.bind(window)
  // jsdom has no ResizeObserver; floating-ui only needs the interface to exist.
  global.ResizeObserver = window.ResizeObserver
    ?? class { observe() {} unobserve() {} disconnect() {} }
  // next/link's intersection-observer prefetch code references `self` directly.
  global.self = global.window
  // Node 24 ships a read-only global `navigator` getter; jsdom's needs to replace it.
  Object.defineProperty(global, 'navigator', { value: window.navigator, configurable: true })
  // React Testing Library reads act() support off this flag.
  ;(global as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
}
