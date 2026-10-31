import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: { include: ['tests/capabilities/**/*.test.ts'], environment: 'node' },
})
