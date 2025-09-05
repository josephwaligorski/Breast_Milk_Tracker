#!/usr/bin/env node
// Simple print agent for Polono PL420 (TSPL) that polls a central server.
// Env:
//   CENTRAL_URL (e.g., http://server:5000)
//   PRINTER_ID (e.g., pi-lab-1)
//   INTERVAL_MS (default 2000)
//   DEVICE (default /dev/usb/lp0)

const fs = require('fs');
const http = require('http');
const https = require('https');

const CENTRAL_URL = process.env.CENTRAL_URL || 'http://localhost:5000';
const PRINTER_ID = process.env.PRINTER_ID || 'default-printer';
const INTERVAL_MS = Number(process.env.INTERVAL_MS || 2000);
const DEVICE = process.env.DEVICE || '/dev/usb/lp0';

const fetchJson = async (url, opts = {}) => {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request({
      method: opts.method || 'GET',
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + (u.search || ''),
      headers: Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {}),
    }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try { resolve(JSON.parse(data || '{}')); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    if (opts.body) req.write(typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body));
    req.end();
  });
};

const tsplForSession = (s) => {
  const dt = new Date(s.timestamp);
  const oz = Number(s.amount_oz || 0);
  const ml = (oz * 29.5735).toFixed(0);
  const wIn = 2.625;
  const hIn = 1.0;
  const pad = 30;
  const y1 = 20, y2 = 50, y3 = 95, y4 = 125;
  const lines = [
    `SIZE ${wIn.toFixed(3)},${hIn.toFixed(3)}`,
    'GAP 0.12,0',
    'DIRECTION 1',
    'REFERENCE 0,0',
    'OFFSET 0.0',
    'SET TEAR ON',
    'CLS',
    `TEXT ${pad},${y1},"0",0,1,1,"${dt.toLocaleDateString('en-US', {timeZone: 'America/New_York'})} ${dt.toLocaleTimeString('en-US', {timeZone: 'America/New_York'})}"`,
    `TEXT ${pad},${y2},"0",0,1,2,"${oz.toFixed(2)} oz (${ml} ml)"`,
    s.notes ? `TEXT ${pad},${y3},"0",0,1,1,"${String(s.notes).replace(/"/g,'\\"').slice(0, 28)}"` : '',
    `TEXT ${pad},${y4},"0",0,1,1,"Fridge: ${new Date(s.use_by_fridge).toLocaleDateString('en-US', {timeZone: 'America/New_York'})}  Freezer: ${new Date(s.use_by_frozen).toLocaleDateString('en-US', {timeZone: 'America/New_York'})}"`,
    'PRINT 1,1',
    'FORMFEED',
  ].filter(Boolean);
  return lines.join('\n') + '\n';
};

const loop = async () => {
  try {
    // Heartbeat
    await fetchJson(`${CENTRAL_URL}/api/agents/heartbeat`, {
      method: 'POST',
      body: { printerId: PRINTER_ID, agentVersion: '1.0.0', capabilities: { tspl: true } },
    });
    // Pull next job
    const { job } = await fetchJson(`${CENTRAL_URL}/api/agents/next-job`, {
      method: 'POST',
      body: { printerId: PRINTER_ID },
    });
    if (job && job.session) {
      try {
        const program = tsplForSession(job.session);
        fs.writeFileSync(DEVICE, program);
        // Report success
        await fetchJson(`${CENTRAL_URL}/api/print/${job.id}/complete`, { method: 'POST', body: { success: true } });
        console.log(`[agent] Printed job ${job.id}`);
      } catch (e) {
        console.error('[agent] Print failed', e.message);
        await fetchJson(`${CENTRAL_URL}/api/print/${job.id}/complete`, { method: 'POST', body: { success: false, error: e.message } });
      }
    }
  } catch (e) {
    console.error('[agent] Loop error', e.message);
  } finally {
    setTimeout(loop, INTERVAL_MS);
  }
};

console.log(`[agent] Starting. CENTRAL_URL=${CENTRAL_URL} PRINTER_ID=${PRINTER_ID} DEVICE=${DEVICE}`);
loop();
