import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

describe('service worker caching', () => {
  it('does not cache failed networkFirst responses', () => {
    const swPath = path.resolve(process.cwd(), 'src/client/public/sw.js');
    const source = readFileSync(swPath, 'utf-8');
    const networkFirstBody = source.match(/async function networkFirst[\s\S]*?async function cacheFirst/)?.[0];

    expect(networkFirstBody).toContain('if (response.ok)');
    expect(networkFirstBody).toMatch(/if \(response\.ok\) \{[\s\S]*cache\.put\(request, response\.clone\(\)\);[\s\S]*\}/);
  });
});
