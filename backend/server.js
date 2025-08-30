const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { spawn } = require('child_process');
const PDFDocument = require('pdfkit');

const app = express();
const PORT = process.env.PORT || 5000;
const DATA_FILE = path.join(__dirname, 'data.json');

// Middleware
app.use(express.json());

// Helper functions to read/write data
const readData = async () => {
  try {
    const data = await fs.readFile(DATA_FILE, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    if (error.code === 'ENOENT') {
      // If file doesn't exist, initialize with empty sessions
      return { sessions: [] };
    }
    throw error;
  }
};

const writeData = async (data) => {
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
    const { sessionId, session } = req.body || {};
    let s = session;
    if (!s && sessionId) {
      const data = await readData();
      s = data.sessions.find(x => x.id === sessionId);
    }
    if (!s) return res.status(400).json({ message: 'No session provided' });

    const dt = new Date(s.timestamp);
    const oz = Number(s.amount_oz || 0);
    const ml = (oz * 29.5735).toFixed(0);

    // Support TSPL raw printing for label printers like Polono PL420
    const printMode = (process.env.PRINT_MODE || '').toLowerCase();
    if (printMode === 'tspl') {
      // Dimensions in inches for TSPL SIZE command
      const wIn = 2.625;
      const hIn = 1.0;
      // Build a simple TSPL program. Coordinates are in dots (at printer dpi). Assume 203dpi common default.
      const dpi = 203;
      const pad = 10; // dots
      const y1 = 10, y2 = 38, y3 = 60, y4 = 80;
      const tsplLines = [
        `SIZE ${wIn.toFixed(3)},${hIn.toFixed(3)}`,
        'GAP 0,0',
        'DIRECTION 1',
        'REFERENCE 0,0',
        'CLS',
        // Date/time
        `TEXT ${pad},${y1},"0",0,1,1,"${dt.toLocaleDateString()} ${dt.toLocaleTimeString()}"`,
        // Amount big
        `TEXT ${pad},${y2},"0",0,2,2,"${oz.toFixed(2)} oz (${ml} ml)"`,
        // Notes (truncated)
        s.notes ? `TEXT ${pad},${y3},"0",0,1,1,"${String(s.notes).replace(/"/g,'\"').slice(0, 32)}"` : '',
        // Use-by
        `TEXT ${pad},${y4},"0",0,1,1,"F: ${new Date(s.use_by_fridge).toLocaleDateString()}  Z: ${new Date(s.use_by_frozen).toLocaleDateString()}"`,
        'PRINT 1,1'
      ].filter(Boolean);
      const program = tsplLines.join('\n') + '\n';

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

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
