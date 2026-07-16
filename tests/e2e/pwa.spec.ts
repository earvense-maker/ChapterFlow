import { test, expect } from '@playwright/test';

test('PWA manifest and service worker assets are available', async ({ page, request }) => {
  await page.goto('/');

  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute(
    'href',
    '/manifest.webmanifest'
  );
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute('content', '#1a1a1a');

  const manifestResponse = await request.get('/manifest.webmanifest');
  expect(manifestResponse.ok()).toBe(true);
  const manifest = await manifestResponse.json();
  expect(manifest.name).toBe('ChapterFlow — API-Powered Narrative Studio');
  expect(manifest.short_name).toBe('ChapterFlow');
  expect(manifest.display).toBe('standalone');
  expect(manifest.icons).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ sizes: '192x192', type: 'image/png', purpose: 'any' }),
      expect.objectContaining({ sizes: '512x512', type: 'image/png', purpose: 'any' }),
      expect.objectContaining({ sizes: '192x192', type: 'image/png', purpose: 'maskable' }),
      expect.objectContaining({ sizes: '512x512', type: 'image/png', purpose: 'maskable' }),
    ])
  );

  const serviceWorkerResponse = await request.get('/sw.js');
  expect(serviceWorkerResponse.ok()).toBe(true);
  const serviceWorkerText = await serviceWorkerResponse.text();
  expect(serviceWorkerText).toContain('CACHE_NAME');
});
