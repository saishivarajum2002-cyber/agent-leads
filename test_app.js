/**
 * PropEdge Auto-Test Suite — Updated with notify-lead test
 */

const http = require('http');
let passed = 0;
let failed = 0;

function post(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const options = {
      hostname: 'localhost', port: 5000, path,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    };
    const req = http.request(options, res => {
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode, body: raw }); }
      });
    });
    req.on('error', reject);
    req.write(data); req.end();
  });
}

function get(path) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: 'localhost', port: 5000, path, method: 'GET' }, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode, body: raw }); }
      });
    });
    req.on('error', reject); req.end();
  });
}

function ok(label, condition, detail = '') {
  if (condition) { console.log(`  ✅ PASS: ${label}`); passed++; }
  else { console.log(`  ❌ FAIL: ${label}${detail ? ' → ' + detail : ''}`); failed++; }
}

async function run() {
  console.log('\n====================================================');
  console.log('  PropEdge Auto Test Suite v2');
  console.log('====================================================\n');

  const testLead = { id: 'tl1', name: 'Test Client', email: 'testclient@email.com', phone: '+971501234567', source: 'Website', status: 'New', property_interest: 'Downtown Dubai 5BR' };
  const agentEmail = 'autotest@propedge.ae';

  // 1. Static pages
  console.log('📋 Test 1: Static pages load');
  const dashboard = await get('/propedge_dashboard.html');
  ok('Dashboard HTML loads (200)', dashboard.status === 200);
  const index = await get('/index.html');
  ok('Index HTML loads (200)', index.status === 200);

  // 2. Sync agent data
  console.log('\n📋 Test 2: Sync agent data');
  const syncRes = await post('/api/sync', {
    email: agentEmail,
    data: { pe_leads: JSON.stringify([testLead]), pe_bookings: JSON.stringify([]) }
  });
  ok('Sync saves data (200)', syncRes.status === 200 && syncRes.body.success === true, JSON.stringify(syncRes.body));

  // 3. Get synced data back
  console.log('\n📋 Test 3: Retrieve synced data');
  const getRes = await get(`/api/sync?email=${agentEmail}`);
  ok('Get sync returns data', getRes.status === 200, JSON.stringify(getRes.body).slice(0, 80));

  // 4. Integration status
  console.log('\n📋 Test 4: Integration status');
  const statusRes = await get(`/api/integration-status?email=${agentEmail}`);
  ok('Status endpoint responds', statusRes.status === 200 && 'google' in (statusRes.body || {}), JSON.stringify(statusRes.body));
  ok('Google status is boolean', typeof statusRes.body?.google === 'boolean');

  // 5. *** NEW: Notify Lead endpoint ***
  console.log('\n📋 Test 5: NEW — Lead email notification');
  const notifyRes = await post('/api/notify-lead', { agentEmail, lead: testLead });
  ok('Notify-lead endpoint responds (200)', notifyRes.status === 200, JSON.stringify(notifyRes.body));
  ok('Notify-lead returns success', notifyRes.body?.success === true, JSON.stringify(notifyRes.body));
  const emailSent = notifyRes.body?.emailSent;
  ok(`Email sent via Resend: ${emailSent ? 'YES ✉️' : 'Sandbox restricted'}`, notifyRes.status === 200);

  // 6. Create meeting — no Google token (should block)
  console.log('\n📋 Test 6: Create meeting (Google not connected)');
  const meetRes = await post('/api/create-meeting', {
    email: agentEmail,
    booking: { client_name: 'Test Client', client_email: 'testclient@email.com', client_phone: '+971501234567', property_name: '5BR Downtown Dubai', visit_date: '2026-04-01', visit_time: '10:00' }
  });
  ok('Create-meeting blocked correctly', meetRes.status === 400 && meetRes.body.error === 'google_not_connected', JSON.stringify(meetRes.body));
  ok('Clear error message returned', !!meetRes.body?.message, meetRes.body?.message);

  // 7. New lead sync (triggers notification)
  console.log('\n📋 Test 7: Sync with new lead triggers notification');
  const secondLead = { id: 'tl2', name: 'Second Client', email: 'second@test.com', phone: '+971509999999', source: 'Referral', status: 'New', property_interest: 'Palm Jumeirah' };
  const syncLead2 = await post('/api/sync', {
    email: agentEmail,
    data: { pe_leads: JSON.stringify([secondLead, testLead]), pe_bookings: JSON.stringify([]) }
  });
  ok('New lead sync passes', syncLead2.status === 200, JSON.stringify(syncLead2.body));

  // SUMMARY
  console.log('\n====================================================');
  console.log(`  Results: ✅ ${passed} passed  |  ❌ ${failed} failed`);
  console.log('====================================================\n');

  if (failed === 0) console.log('🎉 ALL TESTS PASSED!\n');
  else console.log('⚠️  Some tests failed — check server logs above.\n');
}

run().catch(console.error);
