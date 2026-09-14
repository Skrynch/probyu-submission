import { defineConfig } from '@hey-api/openapi-ts';

export default defineConfig({
  input: 'contracts/openapi/openapi.v1.yaml',
  output: {
    path: 'contracts/openapi/generated',
    postProcess: ['prettier'],
  },
  plugins: ['@hey-api/client-fetch', '@hey-api/typescript', '@hey-api/schemas', '@hey-api/sdk'],
});
