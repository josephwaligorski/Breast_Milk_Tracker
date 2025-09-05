const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { spawn } = require('child_process');
const https = require('https');
const net = require('net');
const PDFDocument = require('pdfkit');

const app = express();
const PORT = process.env.PORT || 5000;
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'data.json');

// Middleware
app.use(express.json());

// Helper functions to read/write data
const readData = async () => {
  try {
    const data = await fs.readFile(DATA_FILE, 'utf8');
    const parsed = JSON.parse(data);
    // Backward-compatible defaults
    if (!parsed.sessions) parsed.sessions = [];
    if (!parsed.printJobs) parsed.printJobs = [];
    if (!parsed.agents) parsed.agents = {};
    return parsed;
  } catch (error) {
    if (error.code === 'ENOENT') {
      // If file doesn't exist, initialize with empty sessions
      return { sessions: [], printJobs: [], agents: {} };
    }
    throw error;
  }
};

const writeData = async (data) => {
  // Ensure data dir exists
  try { await fs.mkdir(DATA_DIR, { recursive: true }); } catch {}
  await fs.writeFile(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
};

// API Endpoints
app.get('/api/sessions', async (req, res) => {
  try {
    const data = await readData();
    const totalAmount = data.sessions.reduce((sum, session) => sum + session.amount_oz, 0);
    const sortedSessions = [...data.sessions].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    res.json({ sessions: sortedSessions, total: totalAmount });
  } catch (error) {
    console.error('Error getting sessions:', error);
    res.status(500).send('Server error');
  }
});

app.post('/api/sessions', async (req, res) => {
  try {
    const { amount, notes } = req.body;

    if (typeof amount !== 'number' || amount <= 0) {
      return res.status(400).json({ message: 'Invalid amount.' });
    }

    const timestamp = new Date();
    const use_by_fridge = new Date(timestamp.getTime() + 4 * 24 * 60 * 60 * 1000);
    const use_by_frozen = new Date(timestamp);
    use_by_frozen.setMonth(use_by_frozen.getMonth() + 6);

    const newSession = {
      id: uuidv4(),
      timestamp: timestamp.toISOString(),
      amount_oz: amount,
      notes,
      use_by_fridge: use_by_fridge.toISOString(),
      use_by_frozen: use_by_frozen.toISOString(),
    };

    const data = await readData();
    data.sessions.push(newSession);
    await writeData(data);

    res.status(201).json(newSession);
  } catch (error) {
    console.error('Error saving session:', error);
    res.status(500).send('Server error');
  }
});

// Print a label on the server (Raspberry Pi) without browser dialog
// Expects body: { sessionId } or full session payload
app.post('/api/print', async (req, res) => {
  try {
  const { sessionId, session, printerId, directTcpPrinter } = req.body || {};
    let s = session;
    if (!s && sessionId) {
      const data = await readData();
      s = data.sessions.find(x => x.id === sessionId);
    }
    if (!s) return res.status(400).json({ message: 'No session provided' });

    const dt = new Date(s.timestamp);
    const oz = Number(s.amount_oz || 0);
    const ml = (oz * 29.5735).toFixed(0);

    // Support direct TCP TSPL printing to a networked label printer (e.g., port 9100)
    if (directTcpPrinter && directTcpPrinter.host) {
      const host = String(directTcpPrinter.host);
      const port = Number(directTcpPrinter.port || 9100);
      // Build TSPL program (same as tspl mode)
      const wIn = 2.625;
      const hIn = 1.0;
      const pad = 30;
      const y1 = 20, y2 = 50, y3 = 95, y4 = 125;
      const tsplLines = [
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
        'FORMFEED'
      ].filter(Boolean);
      const program = tsplLines.join('\n') + '\n';
      const sock = net.connect({ host, port });
      const timeoutMs = Number(process.env.TCP_PRINT_TIMEOUT_MS || 5000);
      let done = false;
      const finish = (err) => {
        if (done) return;
        done = true;
        try { sock.destroy(); } catch {}
        if (err) return res.status(502).json({ message: 'TCP print failed', error: String(err.message || err) });
        return res.json({ status: 'printed', mode: 'tspl-tcp', host, port });
      };
      sock.setTimeout(timeoutMs, () => finish(new Error('timeout')));
      sock.on('connect', () => {
        sock.write(program, 'utf8', () => {
          // some printers close after receiving data; give a short delay
          setTimeout(() => finish(null), 100);
        });
      });
      sock.on('error', finish);
      return; // handled
    }

    // If CENTRAL_MODE is enabled or a target printerId is provided, enqueue for a remote agent
    const centralMode = (process.env.CENTRAL_MODE || '0') === '1';
    if (centralMode || printerId) {
      const store = await readData();
      const job = {
        id: uuidv4(),
        printerId: printerId || null,
        status: 'queued',
        createdAt: new Date().toISOString(),
        session: {
          id: s.id,
          timestamp: s.timestamp,
          amount_oz: Number(s.amount_oz || 0),
          notes: s.notes || '',
          use_by_fridge: s.use_by_fridge,
          use_by_frozen: s.use_by_frozen,
        },
      };
      store.printJobs.push(job);
      await writeData(store);
      return res.json({ status: 'queued', jobId: job.id, printerId: job.printerId });
    }

    // Support TSPL raw printing for label printers like Polono PL420
    const printMode = (process.env.PRINT_MODE || '').toLowerCase();
    if (printMode === 'tspl') {
      // Dimensions in inches for TSPL SIZE command
      const wIn = 2.625;
      const hIn = 1.0;
      // Build a simple TSPL program. Coordinates are in dots (at printer dpi). Assume 203dpi common default.
      const dpi = 203;
      const pad = 30; // More left padding
      const y1 = 20, y2 = 50, y3 = 95, y4 = 125; // Increased spacing after volume (y3 moved from 85 to 95)
      const tsplLines = [
        `SIZE ${wIn.toFixed(3)},${hIn.toFixed(3)}`,
        'GAP 0.12,0', // Gap between labels (0.12 inches)
        'DIRECTION 1',
        'REFERENCE 0,0',
        'OFFSET 0.0', // Start printing from beginning of label
        'SET TEAR ON', // Enable tear-off mode
        'CLS',
        // Date/time - Force Eastern timezone display
        `TEXT ${pad},${y1},"0",0,1,1,"${dt.toLocaleDateString('en-US', {timeZone: 'America/New_York'})} ${dt.toLocaleTimeString('en-US', {timeZone: 'America/New_York'})}"`,
        // Amount big - using smaller font to leave more room
        `TEXT ${pad},${y2},"0",0,1,2,"${oz.toFixed(2)} oz (${ml} ml)"`,
        // Notes (truncated) - positioned lower to avoid overlap
  s.notes ? `TEXT ${pad},${y3},"0",0,1,1,"${String(s.notes).replace(/"/g,'\\"').slice(0, 28)}"` : '',
        // Use-by - positioned at bottom
        `TEXT ${pad},${y4},"0",0,1,1,"Fridge: ${new Date(s.use_by_fridge).toLocaleDateString('en-US', {timeZone: 'America/New_York'})}  Freezer: ${new Date(s.use_by_frozen).toLocaleDateString('en-US', {timeZone: 'America/New_York'})}"`,
        'PRINT 1,1',
        'FORMFEED' // Advance label to tear-off position
      ].filter(Boolean);
      const program = tsplLines.join('\n') + '\n';

      // Try direct USB printing first (since CUPS seems to have issues)
      const directPrint = process.env.DIRECT_PRINT === 'true' || process.env.DIRECT_PRINT === '1';
      if (directPrint) {
        try {
          const fs = require('fs');
          fs.writeFileSync('/dev/usb/lp0', program);
          return res.json({ status: 'printed', mode: 'tspl-direct' });
        } catch (err) {
          console.error('Direct print failed:', err.message);
          // Fall back to CUPS
        }
      }

      const printer = process.env.PRINTER || process.env.BMT_PRINTER;
      const args = ['-o', 'raw'];
      if (printer) args.push('-d', printer);
      const lp = spawn('lp', args);
      let stderr = '';
      lp.stderr.on('data', (d) => (stderr += d.toString()));
      lp.on('close', (code) => {
        if (code === 0) return res.json({ status: 'queued', mode: 'tspl' });
        return res.status(500).json({ message: 'Print failed', stderr });
      });
      lp.stdin.write(program, 'utf8');
      lp.stdin.end();
      return; // done
    }

    // Default: PDF via CUPS (media Custom.189x72)
    const width = Math.round(2.625 * 72);
    const height = Math.round(1 * 72);
    const doc = new PDFDocument({ size: [width, height], margin: 6 });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));

    // Layout
    doc.fontSize(9);
    doc.text(`${dt.toLocaleDateString()} ${dt.toLocaleTimeString()}`, { align: 'left' });
    doc.moveDown(0.2);
    doc.fontSize(16).font('Helvetica-Bold');
    doc.text(`${oz.toFixed(2)} oz`, { continued: true });
    doc.font('Helvetica').fontSize(10).text(`  (${ml} ml)`);
    if (s.notes) {
      doc.moveDown(0.1);
      doc.fontSize(8).fillColor('#444');
      const n = String(s.notes).slice(0, 60);
      doc.text(n);
      doc.fillColor('#000');
    }
    doc.moveDown(0.1);
    doc.fontSize(8);
    doc.text(`Fridge: ${new Date(s.use_by_fridge).toLocaleDateString()}   Freeze: ${new Date(s.use_by_frozen).toLocaleDateString()}`);
    doc.end();

    doc.on('end', () => {
      const pdfBuffer = Buffer.concat(chunks);
      const media = process.env.LABEL_MEDIA || 'Custom.189x72';
      const printer = process.env.PRINTER || process.env.BMT_PRINTER;
      const orientation = (process.env.ORIENTATION || process.env.BMT_ORIENTATION || '').toLowerCase();
      const fit = (process.env.PRINT_FIT || '1') !== '0';
      const args = ['-o', `media=${media}`];
      if (fit) args.push('-o', 'fit-to-page');
      else args.push('-o', 'scaling=100');
      if (orientation === 'landscape') args.push('-o', 'landscape');
      if (printer) {
        args.push('-d', printer);
      }
      const lp = spawn('lp', args);
      let stderr = '';
      lp.stderr.on('data', (d) => (stderr += d.toString()));
      lp.on('close', (code) => {
        if (code === 0) return res.json({ status: 'queued', mode: 'pdf' });
        return res.status(500).json({ message: 'Print failed', stderr });
      });
      lp.stdin.write(pdfBuffer);
      lp.stdin.end();
    });
  } catch (err) {
    console.error('Print error', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// --- Centralized printing: Agent endpoints ---
// Agent heartbeat to register presence
app.post('/api/agents/heartbeat', async (req, res) => {
  try {
    const { printerId, agentVersion, capabilities } = req.body || {};
    if (!printerId) return res.status(400).json({ message: 'printerId required' });
    const store = await readData();
    store.agents[printerId] = {
      printerId,
      lastSeen: new Date().toISOString(),
      agentVersion: agentVersion || null,
      capabilities: capabilities || null,
    };
    await writeData(store);
    res.json({ ok: true });
  } catch (e) {
    console.error('Heartbeat failed', e);
    res.status(500).json({ message: 'Server error' });
  }
});

// Agent pulls next job (FIFO) for a given printerId. If printerId is null, it will receive jobs without a specified printer.
app.post('/api/agents/next-job', async (req, res) => {
  try {
    const { printerId } = req.body || {};
    const store = await readData();
    // Strategy:
    // - If printerId provided: prefer jobs explicitly targeted to that printer; otherwise allow unassigned jobs.
    // - If no printerId provided: only unassigned jobs.
    let idx = -1;
    if (printerId) {
      idx = store.printJobs.findIndex(j => j.status === 'queued' && (j.printerId === printerId));
      if (idx === -1) {
        idx = store.printJobs.findIndex(j => j.status === 'queued' && (j.printerId == null));
      }
    } else {
      idx = store.printJobs.findIndex(j => j.status === 'queued' && (j.printerId == null));
    }
    if (idx === -1) return res.json({ job: null });
    const job = store.printJobs[idx];
    job.status = 'claimed';
    job.claimedAt = new Date().toISOString();
    await writeData(store);
    res.json({ job });
  } catch (e) {
    console.error('Next-job failed', e);
    res.status(500).json({ message: 'Server error' });
  }
});

// Agent reports job completion
app.post('/api/print/:jobId/complete', async (req, res) => {
  try {
    const { jobId } = req.params;
    const { success, error } = req.body || {};
    const store = await readData();
    const idx = store.printJobs.findIndex(j => j.id === jobId);
    if (idx === -1) return res.status(404).json({ message: 'Job not found' });
    store.printJobs[idx].status = success ? 'done' : 'failed';
    store.printJobs[idx].finishedAt = new Date().toISOString();
    if (!success) store.printJobs[idx].error = String(error || 'unknown');
    await writeData(store);
    res.json({ ok: true });
  } catch (e) {
    console.error('Complete failed', e);
    res.status(500).json({ message: 'Server error' });
  }
});

// Update a session (amount_oz and/or notes)
app.patch('/api/sessions/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { amount_oz, notes } = req.body;

    const data = await readData();
    const idx = data.sessions.findIndex(s => s.id === id);
    if (idx === -1) {
      return res.status(404).json({ message: 'Session not found' });
    }

    if (amount_oz !== undefined) {
      if (typeof amount_oz !== 'number' || amount_oz <= 0) {
        return res.status(400).json({ message: 'Invalid amount_oz.' });
      }
      data.sessions[idx].amount_oz = amount_oz;
    }
    if (notes !== undefined) {
      data.sessions[idx].notes = notes;
    }

    await writeData(data);
    return res.json(data.sessions[idx]);
  } catch (error) {
    console.error('Error updating session:', error);
    res.status(500).send('Server error');
  }
});

// Delete a session
app.delete('/api/sessions/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const data = await readData();
    const prevLen = data.sessions.length;
    data.sessions = data.sessions.filter(s => s.id !== id);
    if (data.sessions.length === prevLen) {
      return res.status(404).json({ message: 'Session not found' });
    }
    await writeData(data);
    return res.status(204).send();
  } catch (error) {
    console.error('Error deleting session:', error);
    res.status(500).send('Server error');
  }
});

// Production Setup: Serve static React files
app.use(express.static(path.join(__dirname, '..', 'frontend', 'build')));

app.get('*', (req, res) => {
  res.sendFile(path.resolve(__dirname, '..', 'frontend', 'build', 'index.html'));
});

// --- Version and Update Endpoints ---
app.get('/api/version', (req, res) => {
  res.json({
    version: process.env.BUILD_VERSION || '1.0.0',
    commit: process.env.BUILD_COMMIT || 'unknown',
    builtAt: process.env.BUILD_TIME || null,
    node: process.version,
  });
});

const githubGet = (path) => new Promise((resolve, reject) => {
  const opts = {
    hostname: 'api.github.com',
    path,
    method: 'GET',
    headers: { 'User-Agent': 'BreastMilkTracker/1.0' },
  };
  const req = https.request(opts, (resp) => {
    let data = '';
    resp.on('data', (chunk) => (data += chunk));
    resp.on('end', () => {
      try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
    });
  });
  req.on('error', reject);
  req.end();
});

app.get('/api/update/check', async (req, res) => {
  try {
    const owner = 'josephwaligorski';
    const repo = 'Breast_Milk_Tracker';
    const latest = await githubGet(`/repos/${owner}/${repo}/commits/main`);
    const latestSha = latest && latest.sha ? latest.sha : null;
    const currentSha = process.env.BUILD_COMMIT || null;
    const needsUpdate = latestSha && currentSha && latestSha !== currentSha;
    res.json({ latestSha, currentSha, needsUpdate: !!needsUpdate });
  } catch (e) {
    console.error('Update check failed', e);
    res.status(500).json({ message: 'Failed to check updates' });
  }
});

app.post('/api/update', async (req, res) => {
  try {
    // Optional host script strategy: if /app/update.sh exists, run it detached
    const allow = (process.env.ENABLE_SELF_UPDATE || '0') === '1';
    if (!allow) {
      return res.status(501).json({
        message: 'Self-update disabled. SSH and run: docker compose up -d --build',
      });
    }
    const scriptPath = '/app/update.sh';
    const fsSync = require('fs');
    if (fsSync.existsSync(scriptPath)) {
      const child = spawn('sh', [scriptPath], {
        stdio: 'ignore',
        detached: true,
      });
      child.unref();
      return res.json({ status: 'started' });
    }
    // Fallback: try docker compose if available in container (requires /var/run/docker.sock mount)
    const child = spawn('sh', ['-lc', 'docker compose up -d --build'], {
      stdio: 'ignore',
      detached: true,
    });
    child.unref();
    return res.json({ status: 'started' });
  } catch (e) {
    console.error('Self-update failed', e);
    res.status(500).json({ message: 'Self-update failed' });
  }
});

// Printable HTML label for local OS printing from browser
app.get('/labels/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const data = await readData();
    const s = data.sessions.find(x => x.id === id);
    if (!s) return res.status(404).send('Not found');
    const dt = new Date(s.timestamp);
    const oz = Number(s.amount_oz || 0);
    const ml = (oz * 29.5735).toFixed(0);
    const fridge = new Date(s.use_by_fridge).toLocaleDateString('en-US', { timeZone: 'America/New_York' });
    const freezer = new Date(s.use_by_frozen).toLocaleDateString('en-US', { timeZone: 'America/New_York' });
    const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8"/>
  <title>Label ${id}</title>
  <style>
    @page { size: 2.625in 1in; margin: 0.08in; }
    body { margin: 0; font-family: -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; }
    .label { width: 2.625in; height: 1in; box-sizing: border-box; padding-left: 0.15in; display: flex; flex-direction: column; justify-content: center; }
    .dt { font-size: 10px; line-height: 1.1; }
    .amt { font-size: 16px; line-height: 1.1; font-weight: 600; }
    .notes { font-size: 10px; line-height: 1.1; color: #444; }
    .useby { font-size: 10px; line-height: 1.1; }
    .truncate { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  </style>
  <script>
    // Auto-print on load for quick tap-to-print
    window.onload = () => { window.print(); };
  </script>
  </head>
<body>
  <div class="label">
    <div class="dt">${dt.toLocaleDateString('en-US', {timeZone: 'America/New_York'})} ${dt.toLocaleTimeString('en-US', {timeZone: 'America/New_York'})}</div>
    <div class="amt">${oz.toFixed(2)} oz (${ml} ml)</div>
    ${s.notes ? `<div class="notes truncate">${String(s.notes).slice(0, 60)}</div>` : ''}
    <div class="useby">Fridge: ${fridge}  Freezer: ${freezer}</div>
  </div>
</body>
</html>`;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (e) {
    console.error('HTML label error', e);
    res.status(500).send('Server error');
  }
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
