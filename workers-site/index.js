import { getAssetFromKV } from '@cloudflare/kv-asset-handler';
import { decode, encode } from 'bs58';

/**
 * The DEBUG flag will do two things that help during development:
 * 1. we will skip caching on the edge, which makes it easier to
 *    debug.
 * 2. we will return an error message on exception in your Response rather
 *    than the default 404.html page.
 */
const DEBUG = false;

const store = file_store;

addEventListener('fetch', (event) => {
  event.respondWith(handleEvent(event).catch((err) => new Response(err.stack, { status: 500 })));
});

function isBase58(str) {
  try {
    return decode(str) && true;
  } catch (err) {
    return false;
  }
}

async function handleEvent(event) {
  let options = {};

  /**
   * @type {Request}
   */
  const request = event.request;

  const { pathname } = new URL(request.url);

  // Handle upload
  if (request.method === 'POST' && pathname === '/upload') {
    const data = await request.arrayBuffer();
    const checksum = await self.crypto.subtle.digest('SHA-1', data);

    const fileId = encode(new Uint8Array(checksum));
    const expirationTtl = 60 * 60 * 24;

    await store.put(fileId, data,  { expirationTtl });

    const fileType = request.headers.get('Content-Type');
    const fileName = request.headers.get('X-File-Name');
    await store.put(fileId + ':meta', encodeURI(`type=${fileType}&name=${fileName}`), { expirationTtl });

    return new Response(fileId);
  }

  // Handle download
  if (request.method === 'GET' && isBase58(pathname.slice(1))) {
    const fileId = pathname.slice(1);

    const meta = await store.get(fileId + ':meta');
    // We check if meta is set for this file, if not
    // we let the code fall through the 404 error
    if (meta) {
      const data = await store.get(fileId, { type: 'arrayBuffer' });
      const params = new URLSearchParams(meta);
      const fileType = params.get('type');
      const fileName = params.get('name');

      if (data) {
        return new Response(data, {
          status: 200,
          headers: {
            'X-File-Id': fileId,
            'X-File-Name': fileName,
            'Content-Disposition': `inline; filename="${fileName}"`,
            'Content-Type': fileType || 'application/octet-stream'
          }
        });
      }

      // Weird, we found the file type but not the file
      console.warn(`No data found for file ${fileId} but type is set`);
    }
  }

  /**
   * You can add custom logic to how we fetch your assets
   * by configuring the function `mapRequestToAsset`
   */
  // options.mapRequestToAsset = handlePrefix(/^\/docs/)

  try {
    if (DEBUG) {
      // customize caching
      options.cacheControl = {
        bypassCache: true
      };
    }

    const page = await getAssetFromKV(event, options);

    // allow headers to be altered
    const response = new Response(page.body, page);

    response.headers.set('X-XSS-Protection', '1; mode=block');
    response.headers.set('X-Content-Type-Options', 'nosniff');
    response.headers.set('X-Frame-Options', 'DENY');
    response.headers.set('Referrer-Policy', 'unsafe-url');
    response.headers.set('Feature-Policy', 'none');

    return response;
  } catch (e) {
    // if an error is thrown try to serve the asset at 404.html
    if (!DEBUG) {
      try {
        let notFoundResponse = await getAssetFromKV(event, {
          mapRequestToAsset: (req) => new Request(`${new URL(req.url).origin}/404.html`, req)
        });

        return new Response(notFoundResponse.body, { ...notFoundResponse, status: 404 });
      } catch (e) {}
    }

    return new Response(e.message || e.toString(), { status: 500 });
  }
}
