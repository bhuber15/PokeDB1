import { installDom } from '@/components/test-helpers'

// Preloaded via `--import` in the test script so every *.test.tsx file has a
// DOM available before React/Testing Library are imported (they touch
// `document` at import time, before any test-local setup could run).
installDom()
