import http from 'node:http';
import AdmZip from 'adm-zip';
import { createStudioApp } from '../src/studio-server.js';
import { sanitizeSvg } from '../src/problem-ops.js';

async function runSecurityTests() {
  console.log('--- Starting security and storage tests ---\n');

  // 1. Test SVG sanitization (stored XSS)
  console.log('[Test 1] SVG sanitization blocks stored XSS');
  const dirtySvg = `<svg xmlns="http://www.w3.org/2000/svg">
  <circle cx="50" cy="50" r="40" stroke="green" fill="yellow" onload="alert('XSS')" />
  <script type="text/javascript">alert('document.cookie');</script>
  <a href="javascript:alert(1)"><text y="20">Click</text></a>
</svg>`;
  const cleanedSvg = sanitizeSvg(Buffer.from(dirtySvg, 'utf8')).toString('utf8');
  console.log('- SVG after sanitization:');
  console.log(cleanedSvg);

  if (cleanedSvg.includes('<script') || cleanedSvg.includes('onload=') || cleanedSvg.includes('javascript:')) {
    throw new Error('The SVG sanitizer still let dangerous code through!');
  }
  console.log('-> [PASS] <script>, onload, and javascript: were all fully stripped\n');

  // 2. Test authentication when STUDIO_PASSWORD is set
  console.log('[Test 2] Verify STUDIO_PASSWORD authentication (login page, sessions, CSRF)');
  process.env.STUDIO_PASSWORD = 'supersecret_test_password';

  const app = createStudioApp();
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('Cannot bind server');
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  try {
    // 3.1 Request with no password -> must get 401 Unauthorized
    const resNoAuth = await fetch(`${baseUrl}/api/problems`);
    console.log(`- Request with no password: HTTP status = ${resNoAuth.status}`);
    if (resNoAuth.status !== 401) {
      throw new Error(`Expected HTTP 401 but got ${resNoAuth.status}`);
    }

    // 3.2 Request with correct HTTP Basic Auth -> must get 200 OK
    const basicAuth = Buffer.from('admin:supersecret_test_password').toString('base64');
    const resAuth = await fetch(`${baseUrl}/api/problems`, {
      headers: { Authorization: `Basic ${basicAuth}` },
    });
    console.log(`- Request with correct Basic Auth: HTTP status = ${resAuth.status}`);
    if (resAuth.status !== 200) {
      throw new Error(`Expected HTTP 200 but got ${resAuth.status}`);
    }

    // 3.3 Request with the X-Studio-Password header -> must get 200 OK
    const resHeaderAuth = await fetch(`${baseUrl}/api/problems`, {
      headers: { 'X-Studio-Password': 'supersecret_test_password' },
    });
    console.log(`- Request with X-Studio-Password: HTTP status = ${resHeaderAuth.status}`);
    if (resHeaderAuth.status !== 200) {
      throw new Error(`Expected HTTP 200 but got ${resHeaderAuth.status}`);
    }
    // 3.4 A browser asking for a page (not the API) must be sent to the login page rather than
    //     given a bare 401 — and must NOT be sent WWW-Authenticate, which is what makes the
    //     browser show its old Basic-auth popup instead of our page.
    const resPage = await fetch(`${baseUrl}/`, { redirect: 'manual' });
    console.log(`- Page request with no session: HTTP status = ${resPage.status}`);
    if (resPage.status !== 303 || !(resPage.headers.get('location') ?? '').startsWith('/login')) {
      throw new Error(`Expected a 303 redirect to /login but got ${resPage.status}`);
    }
    if (resPage.headers.get('www-authenticate')) {
      throw new Error('WWW-Authenticate is still being sent — the browser will show the Basic-auth popup');
    }

    // 3.5 The login page itself must be reachable without credentials, or nobody can ever log in
    const resLogin = await fetch(`${baseUrl}/login`);
    const loginHtml = await resLogin.text();
    console.log(`- GET /login without credentials: HTTP status = ${resLogin.status}`);
    if (resLogin.status !== 200 || !loginHtml.includes('name="password"')) {
      throw new Error('The login page is not being served to anonymous visitors');
    }

    // 3.6 Wrong password: rejected, and no session handed out
    const resBadLogin = await fetch(`${baseUrl}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ password: 'not-the-password' }).toString(),
      redirect: 'manual',
    });
    console.log(`- POST /login with the wrong password: HTTP status = ${resBadLogin.status}`);
    if (resBadLogin.status !== 401) {
      throw new Error(`Expected HTTP 401 but got ${resBadLogin.status}`);
    }
    if (resBadLogin.headers.get('set-cookie')) {
      throw new Error('A failed login handed out a session cookie');
    }

    // 3.7 Correct password: a session cookie that JavaScript cannot read and that the browser
    //     will not attach to requests another site started
    const resGoodLogin = await fetch(`${baseUrl}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ password: 'supersecret_test_password' }).toString(),
      redirect: 'manual',
    });
    const setCookie = resGoodLogin.headers.get('set-cookie') ?? '';
    console.log(`- POST /login with the correct password: HTTP status = ${resGoodLogin.status}`);
    if (resGoodLogin.status !== 303) {
      throw new Error(`Expected a 303 redirect but got ${resGoodLogin.status}`);
    }
    for (const attribute of ['HttpOnly', 'SameSite=Strict', 'Secure']) {
      if (!setCookie.includes(attribute)) {
        throw new Error(`The session cookie is missing ${attribute}: ${setCookie}`);
      }
    }

    // 3.8 That session must actually open the API
    const sessionCookie = setCookie.split(';')[0] ?? '';
    const resWithSession = await fetch(`${baseUrl}/api/problems`, { headers: { Cookie: sessionCookie } });
    console.log(`- API request carrying the session cookie: HTTP status = ${resWithSession.status}`);
    if (resWithSession.status !== 200) {
      throw new Error(`Expected HTTP 200 but got ${resWithSession.status}`);
    }

    // 3.9 A valid session is not enough if the request came from somewhere else. This is the
    //     attack the old Basic-auth gate had no answer to: a page on another domain making the
    //     logged-in author's browser delete a problem.
    const resCrossSite = await fetch(`${baseUrl}/api/problems/anything`, {
      method: 'DELETE',
      headers: { Cookie: sessionCookie, Origin: 'https://evil.example' },
    });
    console.log(`- Cross-site DELETE with a valid session: HTTP status = ${resCrossSite.status}`);
    if (resCrossSite.status !== 403) {
      throw new Error(`Expected HTTP 403 but got ${resCrossSite.status}`);
    }

    // 3.10 The health probe has to answer without credentials or the container is marked
    //      unhealthy forever and ZimaOS will keep restarting it.
    const resHealth = await fetch(`${baseUrl}/healthz`);
    console.log(`- GET /healthz without credentials: HTTP status = ${resHealth.status}`);
    if (resHealth.status !== 200) {
      throw new Error(`Expected HTTP 200 but got ${resHealth.status}`);
    }

    // 3.11 Signing out must revoke the cookie the browser is holding
    const resLogout = await fetch(`${baseUrl}/logout`, {
      method: 'POST',
      headers: { Cookie: sessionCookie },
      redirect: 'manual',
    });
    const clearCookie = resLogout.headers.get('set-cookie') ?? '';
    console.log(`- POST /logout: HTTP status = ${resLogout.status}`);
    if (resLogout.status !== 303 || !clearCookie.includes('Max-Age=0')) {
      throw new Error('Signing out did not clear the session cookie');
    }

    console.log('-> [PASS] Login, sessions, cross-site protection and the health probe all behave\n');

    // 3. Test security headers
    console.log('[Test 3] Verify security headers (X-Frame-Options, X-Content-Type-Options)');
    const xFrame = resAuth.headers.get('x-frame-options');
    const xContentType = resAuth.headers.get('x-content-type-options');
    console.log(`- X-Frame-Options: ${xFrame}`);
    console.log(`- X-Content-Type-Options: ${xContentType}`);
    if (xFrame !== 'SAMEORIGIN' || xContentType !== 'nosniff') {
      throw new Error('Security headers are incorrect');
    }
    console.log('-> [PASS] All security headers are set correctly\n');

    // 4. Test zip bomb protection
    console.log('[Test 4] Verify zip bomb protection (> 100MB)');
    const bigZip = new AdmZip();
    const dummy = Buffer.alloc(1024, 'A');
    for (let i = 0; i < 105; i++) {
      bigZip.addFile(`huge_problem_${i}/problem.yaml`, dummy);
      const entries = bigZip.getEntries();
      const last = entries[entries.length - 1];
      if (last) {
        last.header.size = 2 * 1024 * 1024; // 2MB each -> 210MB total
      }
    }
    const bombForm = new FormData();
    bombForm.append('file', new Blob([new Uint8Array(bigZip.toBuffer())], { type: 'application/zip' }), 'bomb.zip');
    const resBomb = await fetch(`${baseUrl}/api/import-zip`, {
      method: 'POST',
      headers: { 'X-Studio-Password': 'supersecret_test_password' },
      body: bombForm,
    });
    const bombData = (await resBomb.json()) as { error?: { message: string } };
    console.log(`- Zip bomb result: status = ${resBomb.status}, message = ${bombData.error?.message}`);
    if (resBomb.status === 400 && bombData.error?.message.includes('100MB')) {
      console.log('-> [PASS] The system rejected the zip bomb exceeding 100MB decompressed\n');
    } else {
      throw new Error('Zip bomb protection failed');
    }

    // 5. Test rate limiting for heavy operations
    console.log('[Test 5] Verify rate limiting (heavy limiter)');
    let blocked = false;
    for (let i = 0; i < 15; i++) {
      const resRate = await fetch(`${baseUrl}/api/booklet`, {
        method: 'POST',
        headers: { 'X-Studio-Password': 'supersecret_test_password' },
      });
      if (resRate.status === 429) {
        blocked = true;
        console.log(`- Request ${i + 1}: blocked with HTTP 429 Too Many Requests as expected`);
        break;
      }
    }
    if (!blocked) {
      throw new Error('The heavy limiter did not block after more than 10 rapid requests!');
    }
    console.log('-> [PASS] Rate limiting works correctly\n');

    console.log('======================================================');
    console.log('  🎉 Summary: all 5/5 security tests passed!');
    console.log('======================================================\n');
  } finally {
    delete process.env.STUDIO_PASSWORD;
    // closeAllConnections() as well as close(): fetch() keeps its sockets alive, and close()
    // only stops new connections — without this the script prints its summary and then hangs
    // forever instead of exiting, which makes it unusable as a CI gate.
    server.closeAllConnections?.();
    server.close();
  }
}

runSecurityTests()
  .then(() => {
    // Exit explicitly. The rate limiter and the HTTP agent keep timers and sockets alive past
    // the last assertion, so without this the script passes and then hangs, which reads as a
    // failure to any CI runner waiting on it.
    process.exit(0);
  })
  .catch((err) => {
    console.error('\n❌ Test error:', err);
    process.exit(1);
  });
